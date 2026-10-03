package dial

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"zakura.dev/agent/internal/rpc"
	"zakura.dev/agent/internal/sys"
)

type Config struct {
	ServerURL string
	Token     string
	Kind      string
	Handler   *rpc.Handler
}

func Loop(ctx context.Context, cfg Config) {
	loopWith(ctx, cfg, defaultDependencies(cfg.Handler))
}

func loopWith(ctx context.Context, cfg Config, deps dependencies) {
	backoff := time.Second
	for ctx.Err() == nil {
		connected, err := connectOnceWith(ctx, cfg, deps)
		if err != nil {
			log.Printf("zakura-agent: 连接断开: %v，%s 后重试", err, backoff)
		}
		if connected {
			backoff = time.Second
		}
		if !deps.wait(ctx, backoff) {
			return
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func connectOnce(ctx context.Context, cfg Config) error {
	_, err := connectOnceWith(ctx, cfg, defaultDependencies(cfg.Handler))
	return err
}

func connectOnceWith(ctx context.Context, cfg Config, deps dependencies) (bool, error) {
	u, err := hubURL(cfg.ServerURL)
	if err != nil {
		return false, err
	}
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+cfg.Token)
	c, err := deps.dial(ctx, u, hdr)
	if err != nil {
		return false, err
	}
	connected := true
	defer c.Close()
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopClose := context.AfterFunc(connCtx, func() { _ = c.Close() })
	defer stopClose()

	// RPC、流和心跳来自不同 goroutine；Gorilla 只允许一个并发 writer。
	var writeMu sync.Mutex
	write := func(m rpc.Msg) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = c.SetWriteDeadline(deps.now().Add(10 * time.Second))
		return c.WriteJSON(m)
	}
	if err := write(rpc.Hello(cfg.Token, sys.Version, cfg.Kind)); err != nil {
		return connected, err
	}

	send := func(m rpc.Msg) {
		if connCtx.Err() != nil {
			return
		}
		if err := write(m); err != nil {
			cancel()
		}
	}

	c.SetReadLimit(16 << 20)
	limit := deps.maxInFlight
	if limit <= 0 {
		limit = 1
	}
	sem := make(chan struct{}, limit)
	var dispatches sync.WaitGroup
	drain := func() {
		done := make(chan struct{})
		go func() { dispatches.Wait(); close(done) }()
		timer := time.NewTimer(deps.drainTimeout)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
		}
	}
	defer drain()
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			cancel()
			return connected, err
		}
		var msg rpc.Msg
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.Type == "welcome" || msg.Type == "ping" {
			if msg.Type == "ping" {
				send(rpc.Msg{Type: "pong", ID: msg.ID})
			}
			continue
		}
		if msg.Type != "req" {
			continue
		}
		select {
		case sem <- struct{}{}:
		case <-connCtx.Done():
			return connected, connCtx.Err()
		}
		dispatches.Add(1)
		go func(request rpc.Msg) {
			defer dispatches.Done()
			defer func() { <-sem }()
			deps.dispatch.Dispatch(connCtx, request, send)
		}(msg)
	}
}

func hubURL(server string) (string, error) {
	s := strings.TrimRight(strings.TrimSpace(server), "/")
	if s == "" {
		return "", os.ErrInvalid
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		u.Scheme = "wss"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/runtime-nodes/hub"
	u.RawQuery = ""
	return u.String(), nil
}
