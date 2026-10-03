package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"zakura.dev/agent/internal/host"
)

// dispatchHost owns the host process and interactive-stream RPC family.  It
// deliberately returns a value rather than replying itself: Dispatch remains
// the single reply boundary for every request.
func (h *Handler) dispatchHost(ctx context.Context, msg Msg, send func(Msg)) (bool, any, error) {
	if !isHostMethod(msg.Method) {
		return false, nil, nil
	}
	if len(msg.Params) != 0 && !json.Valid(msg.Params) {
		return true, nil, errors.New("invalid JSON params")
	}
	var result any
	var err error
	switch msg.Method {
	case "host.exec":
		result, err = h.hostExec(ctx, msg.Params)
	case "host.exec.start":
		result, err = h.hostExecStart(ctx, msg.Params)
	case "host.exec.get":
		result, err = h.hostExecGet(msg.Params)
	case "host.exec.kill":
		result, err = h.hostExecKill(msg.Params)
	case "host.pty.start":
		result, err = h.ptyStart(msg.Params, send)
	case "host.pty.write":
		err = h.ptyWrite(msg.Params)
		result = map[string]bool{"ok": err == nil}
	case "host.pty.resize":
		err = h.ptyResize(msg.Params)
		result = map[string]bool{"ok": err == nil}
	case "host.pty.close":
		err = h.ptyClose(msg.Params)
		result = map[string]bool{"ok": true}
	}
	return true, result, err
}

func isHostMethod(method string) bool {
	switch method {
	case "host.exec", "host.exec.start", "host.exec.get", "host.exec.kill",
		"host.pty.start", "host.pty.write", "host.pty.resize", "host.pty.close":
		return true
	default:
		return false
	}
}

func decodeParams(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	return json.Unmarshal(raw, dst)
}

func (h *Handler) hostExec(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		host.ExecParams
		SpaceID string `json:"spaceId"`
	}
	_ = json.Unmarshal(raw, &p)
	root := h.StorageRoot
	if p.SpaceID != "" {
		root = h.workspace(p.SpaceID)
		_ = host.EnsureDir(root)
	}
	return host.RunContext(ctx, root, p.ExecParams)
}

func (h *Handler) hostExecStart(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		host.ExecParams
		SpaceID string `json:"spaceId"`
	}
	_ = json.Unmarshal(raw, &p)
	root := h.StorageRoot
	if p.SpaceID != "" {
		root = h.workspace(p.SpaceID)
		_ = host.EnsureDir(root)
	}
	return h.jobs.StartContext(ctx, root, p.ExecParams)
}

func (h *Handler) hostExecGet(raw json.RawMessage) (any, error) {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	snap := h.jobs.Get(p.ID)
	if snap == nil {
		return nil, fmt.Errorf("job 不存在")
	}
	return snap, nil
}

func (h *Handler) hostExecKill(raw json.RawMessage) (any, error) {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	snap := h.jobs.Kill(p.ID)
	if snap == nil {
		return nil, fmt.Errorf("job 不存在")
	}
	return snap, nil
}

func (h *Handler) ptyStart(raw json.RawMessage, send func(Msg)) (any, error) {
	var p struct {
		host.ExecParams
		SpaceID string `json:"spaceId"`
		Cols    int    `json:"cols"`
		Rows    int    `json:"rows"`
	}
	_ = json.Unmarshal(raw, &p)
	root := h.StorageRoot
	if p.SpaceID != "" {
		root = h.workspace(p.SpaceID)
		_ = host.EnsureDir(root)
	}
	sess, err := host.StartPty(root, p.ExecParams, p.Cols, p.Rows)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.ptys[sess.ID] = sess
	h.mu.Unlock()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				send(Msg{
					Type:   "stream",
					Stream: sess.ID,
					Chan:   "stdout",
					Data:   base64.StdEncoding.EncodeToString(buf[:n]),
				})
			}
			if err != nil {
				if err != io.EOF && !strings.Contains(err.Error(), "file already closed") {
					send(Msg{Type: "stream", Stream: sess.ID, Chan: "stderr", Data: err.Error()})
				}
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "exit"})
				return
			}
		}
	}()
	return map[string]any{"id": sess.ID, "mode": sess.Mode}, nil
}

func (h *Handler) ptyWrite(raw json.RawMessage) error {
	var p struct {
		ID     string `json:"id"`
		Base64 string `json:"base64"`
		Data   string `json:"data"`
	}
	_ = json.Unmarshal(raw, &p)
	h.mu.Lock()
	s := h.ptys[p.ID]
	h.mu.Unlock()
	if s == nil {
		return fmt.Errorf("pty 不存在")
	}
	b := []byte(p.Data)
	if p.Base64 != "" {
		var err error
		b, err = base64.StdEncoding.DecodeString(p.Base64)
		if err != nil {
			return err
		}
	}
	_, err := s.Write(b)
	return err
}

func (h *Handler) ptyResize(raw json.RawMessage) error {
	var p struct {
		ID   string `json:"id"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	_ = json.Unmarshal(raw, &p)
	h.mu.Lock()
	s := h.ptys[p.ID]
	h.mu.Unlock()
	if s == nil {
		return fmt.Errorf("pty 不存在")
	}
	return s.Resize(p.Cols, p.Rows)
}

func (h *Handler) ptyClose(raw json.RawMessage) error {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	h.mu.Lock()
	s := h.ptys[p.ID]
	delete(h.ptys, p.ID)
	h.mu.Unlock()
	if s != nil {
		return s.Close()
	}
	return nil
}
