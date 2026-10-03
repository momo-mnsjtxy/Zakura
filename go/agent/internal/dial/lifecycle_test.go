package dial

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zakura.dev/agent/internal/rpc"
)

type fakeConn struct {
	mu       sync.Mutex
	reads    [][]byte
	writes   []rpc.Msg
	closed   atomic.Int32
	deadline time.Time
	readDone <-chan struct{}
}

func (f *fakeConn) Close() error                       { f.closed.Add(1); return nil }
func (f *fakeConn) SetWriteDeadline(v time.Time) error { f.deadline = v; return nil }
func (f *fakeConn) WriteJSON(value any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, value.(rpc.Msg))
	return nil
}
func (*fakeConn) SetReadLimit(int64) {}
func (f *fakeConn) ReadMessage() (int, []byte, error) {
	f.mu.Lock()
	if len(f.reads) > 0 {
		v := f.reads[0]
		f.reads = f.reads[1:]
		f.mu.Unlock()
		return 1, v, nil
	}
	done := f.readDone
	f.mu.Unlock()
	if done != nil {
		<-done
	}
	return 0, nil, errors.New("disconnected")
}

func frame(t *testing.T, m rpc.Msg) []byte {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type fakeDispatcher struct {
	active  atomic.Int32
	maximum atomic.Int32
	release <-chan struct{}
	late    bool
}

func (f *fakeDispatcher) Dispatch(ctx context.Context, msg rpc.Msg, send func(rpc.Msg)) {
	n := f.active.Add(1)
	for {
		old := f.maximum.Load()
		if n <= old || f.maximum.CompareAndSwap(old, n) {
			break
		}
	}
	if f.release != nil {
		<-f.release
	}
	if f.late {
		<-ctx.Done()
	}
	send(rpc.Ok(msg.ID, map[string]bool{"ok": true}))
	f.active.Add(-1)
}

func fakeDeps(conn connection, dispatch dispatcher) dependencies {
	return dependencies{
		dial: func(_ context.Context, _ string, h http.Header) (connection, error) {
			if h.Get("Authorization") != "Bearer token" {
				return nil, errors.New("bad auth")
			}
			return conn, nil
		},
		wait: func(context.Context, time.Duration) bool { return false }, now: func() time.Time { return time.Unix(10, 0) }, maxInFlight: 1, drainTimeout: time.Second, dispatch: dispatch,
	}
}

func TestFakeTransportPreservesFramesBoundsDispatchAndSerializesWrites(t *testing.T) {
	release := make(chan struct{})
	readDone := make(chan struct{})
	dispatch := &fakeDispatcher{release: release}
	conn := &fakeConn{readDone: readDone, reads: [][]byte{
		[]byte("{"), frame(t, rpc.Msg{Type: "welcome"}),
		frame(t, rpc.Msg{Type: "ping", ID: "p"}),
		frame(t, rpc.Msg{Type: "req", ID: "1", Method: "x"}),
		frame(t, rpc.Msg{Type: "req", ID: "2", Method: "x"}),
	}}
	done := make(chan error, 1)
	go func() {
		_, err := connectOnceWith(context.Background(), Config{ServerURL: "https://example.test", Token: "token", Kind: "computer"}, fakeDeps(conn, dispatch))
		done <- err
	}()
	for dispatch.active.Load() != 1 {
		time.Sleep(time.Millisecond)
	}
	if dispatch.maximum.Load() != 1 {
		t.Fatalf("maximum=%d", dispatch.maximum.Load())
	}
	close(release)
	for {
		conn.mu.Lock()
		count := len(conn.writes)
		conn.mu.Unlock()
		if count == 4 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	close(readDone)
	if err := <-done; err == nil {
		t.Fatal("expected disconnect")
	}
	if dispatch.maximum.Load() != 1 {
		t.Fatalf("maximum=%d", dispatch.maximum.Load())
	}
	conn.mu.Lock()
	writes := append([]rpc.Msg(nil), conn.writes...)
	conn.mu.Unlock()
	if len(writes) != 4 || writes[0].Type != "hello" || writes[1].Type != "pong" || writes[2].ID != "1" || writes[3].ID != "2" {
		t.Fatalf("writes=%#v", writes)
	}
	if conn.deadline != time.Unix(20, 0) {
		t.Fatalf("deadline=%v", conn.deadline)
	}
}

func TestDisconnectCancelsDispatchAndSuppressesLateWrite(t *testing.T) {
	dispatch := &fakeDispatcher{late: true}
	conn := &fakeConn{reads: [][]byte{frame(t, rpc.Msg{Type: "req", ID: "late", Method: "x"})}}
	_, err := connectOnceWith(context.Background(), Config{ServerURL: "https://example.test", Token: "token"}, fakeDeps(conn, dispatch))
	if err == nil {
		t.Fatal("expected disconnect")
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if len(conn.writes) != 1 || conn.writes[0].Type != "hello" {
		t.Fatalf("late write admitted: %#v", conn.writes)
	}
}

func TestInjectedBackoffWaitHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	deps := fakeDeps(&fakeConn{}, &fakeDispatcher{})
	deps.wait = func(ctx context.Context, _ time.Duration) bool { called = true; return ctx.Err() == nil }
	if deps.wait(ctx, time.Second) {
		t.Fatal("canceled wait succeeded")
	}
	if !called {
		t.Fatal("wait not called")
	}
}

func TestReconnectBackoffProgressesAndResetsAfterConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	dials := 0
	var waits []time.Duration
	deps := fakeDeps(&fakeConn{}, &fakeDispatcher{})
	deps.dial = func(context.Context, string, http.Header) (connection, error) {
		dials++
		if dials <= 2 {
			return nil, errors.New("dial failed")
		}
		return &fakeConn{}, nil
	}
	deps.wait = func(_ context.Context, delay time.Duration) bool {
		waits = append(waits, delay)
		if len(waits) == 3 {
			cancel()
			return false
		}
		return true
	}
	loopWith(ctx, Config{ServerURL: "https://example.test", Token: "token"}, deps)
	want := []time.Duration{time.Second, 2 * time.Second, time.Second}
	if len(waits) != len(want) {
		t.Fatalf("waits=%v", waits)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits=%v want=%v", waits, want)
		}
	}
}
