package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"sync/atomic"
	"testing"

	"zakura.dev/agent/internal/docker"
	"zakura.dev/agent/internal/host"
)

type fakeOperationExecutor struct {
	productionOperationExecutor
	pulls atomic.Int32
	pull  func(context.Context, string, func(docker.PullEvent)) error
}

func (f *fakeOperationExecutor) Pull(ctx context.Context, image string, progress func(docker.PullEvent)) error {
	f.pulls.Add(1)
	return f.pull(ctx, image, progress)
}

func collectDispatch(h *Handler, ctx context.Context, msg Msg) []Msg {
	var got []Msg
	h.Dispatch(ctx, msg, func(m Msg) { got = append(got, m) })
	return got
}

func TestDockerDispatchProgressThenExactlyOneReply(t *testing.T) {
	fake := &fakeOperationExecutor{pull: func(_ context.Context, image string, progress func(docker.PullEvent)) error {
		if image != "example/image:tag" {
			t.Fatalf("image = %q", image)
		}
		progress(docker.PullEvent{Status: "Downloading"})
		return nil
	}}
	h := New("runner", t.TempDir())
	h.operations = fake
	params, _ := json.Marshal(map[string]any{"image": "example/image:tag", "progressStream": "progress-1"})
	got := collectDispatch(h, context.Background(), Msg{ID: "req-1", Method: "docker.pull", Params: params})
	if len(got) != 2 {
		t.Fatalf("messages = %d, want stream + reply", len(got))
	}
	if got[0].Type != "stream" || got[0].Stream != "progress-1" || got[0].Chan != "progress" {
		t.Fatalf("progress = %#v", got[0])
	}
	raw, err := base64.StdEncoding.DecodeString(got[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	var event docker.PullEvent
	if err := json.Unmarshal(raw, &event); err != nil || event.Status != "Downloading" {
		t.Fatalf("event = %#v, err=%v", event, err)
	}
	if got[1].Type != "res" || got[1].ID != "req-1" || got[1].OK == nil || !*got[1].OK {
		t.Fatalf("reply = %#v", got[1])
	}
}

func TestDockerDispatchMalformedDoesNotExecuteAndRepliesOnce(t *testing.T) {
	fake := &fakeOperationExecutor{pull: func(context.Context, string, func(docker.PullEvent)) error { t.Fatal("executor called"); return nil }}
	h := New("runner", t.TempDir())
	h.operations = fake
	got := collectDispatch(h, context.Background(), Msg{ID: "bad", Method: "docker.pull", Params: json.RawMessage(`{"image":`)})
	if len(got) != 1 || got[0].Type != "res" || got[0].OK == nil || *got[0].OK || got[0].Error == "" {
		t.Fatalf("messages = %#v", got)
	}
	if fake.pulls.Load() != 0 {
		t.Fatalf("pull calls = %d", fake.pulls.Load())
	}
}

func TestDockerDispatchPropagatesCancellation(t *testing.T) {
	fake := &fakeOperationExecutor{pull: func(ctx context.Context, _ string, _ func(docker.PullEvent)) error { return ctx.Err() }}
	h := New("runner", t.TempDir())
	h.operations = fake
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := collectDispatch(h, ctx, Msg{ID: "cancel", Method: "docker.pull", Params: json.RawMessage(`{"image":"x"}`)})
	if len(got) != 1 || got[0].Error != context.Canceled.Error() {
		t.Fatalf("messages = %#v", got)
	}
}

func TestUnknownMethodRepliesOnce(t *testing.T) {
	got := collectDispatch(New("runner", t.TempDir()), context.Background(), Msg{ID: "unknown", Method: "other.method"})
	if len(got) != 1 || got[0].OK == nil || *got[0].OK {
		t.Fatalf("messages = %#v", got)
	}
}

func TestHostDispatchMalformedRepliesOnce(t *testing.T) {
	got := collectDispatch(New("runner", t.TempDir()), context.Background(), Msg{ID: "bad-host", Method: "host.exec", Params: json.RawMessage(`{"command":`)})
	if len(got) != 1 || got[0].OK == nil || *got[0].OK || got[0].Error != "invalid JSON params" {
		t.Fatalf("messages = %#v", got)
	}
}

type countingCloser struct{ closes atomic.Int32 }

func (c *countingCloser) Close() error                { c.closes.Add(1); return nil }
func (c *countingCloser) Write(p []byte) (int, error) { return len(p), nil }

type eofCloser struct{ countingCloser }

func (*eofCloser) Read([]byte) (int, error) { return 0, io.EOF }

func TestRepeatedStreamCloseIsIdempotent(t *testing.T) {
	in := &countingCloser{}
	out := &eofCloser{}
	h := New("runner", t.TempDir())
	h.ptys["stream-1"] = &host.LiveStream{ID: "stream-1", In: in, Out: out}
	msg := Msg{Method: "host.pty.close", Params: json.RawMessage(`{"id":"stream-1"}`)}
	first := collectDispatch(h, context.Background(), msg)
	second := collectDispatch(h, context.Background(), msg)
	if len(first) != 1 || first[0].OK == nil || !*first[0].OK || len(second) != 1 || second[0].OK == nil || !*second[0].OK {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
	if in.closes.Load() != 1 || out.closes.Load() != 1 {
		t.Fatalf("closes in=%d out=%d", in.closes.Load(), out.closes.Load())
	}
}
