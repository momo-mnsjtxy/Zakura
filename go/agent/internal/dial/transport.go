package dial

import (
	"context"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"zakura.dev/agent/internal/rpc"
)

type connection interface {
	Close() error
	SetWriteDeadline(time.Time) error
	WriteJSON(any) error
	SetReadLimit(int64)
	ReadMessage() (int, []byte, error)
}

type dispatcher interface {
	Dispatch(context.Context, rpc.Msg, func(rpc.Msg))
}

type dependencies struct {
	dial         func(context.Context, string, http.Header) (connection, error)
	wait         func(context.Context, time.Duration) bool
	now          func() time.Time
	maxInFlight  int
	drainTimeout time.Duration
	dispatch     dispatcher
}

func defaultDependencies(handler dispatcher) dependencies {
	return dependencies{
		dial: func(ctx context.Context, url string, header http.Header) (connection, error) {
			conn, _, err := websocket.DefaultDialer.DialContext(ctx, url, header)
			return conn, err
		},
		wait: func(ctx context.Context, delay time.Duration) bool {
			timer := time.NewTimer(delay)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return false
			case <-timer.C:
				return true
			}
		},
		now: time.Now, maxInFlight: 32, drainTimeout: 2 * time.Second, dispatch: handler,
	}
}
