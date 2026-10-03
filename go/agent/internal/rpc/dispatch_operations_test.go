package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"zakura.dev/agent/internal/docker"
	"zakura.dev/agent/internal/sys"
)

type scriptedOperations struct {
	update   func(context.Context, sys.UpdateParams, func(sys.UpdateProgress)) (sys.UpdateResult, error)
	pull     func(context.Context, string, func(docker.PullEvent)) error
	images   func(context.Context, []string) []docker.ImageStatus
	recreate func(context.Context, string) (docker.RecreateResult, error)
}

func (s scriptedOperations) Update(c context.Context, p sys.UpdateParams, f func(sys.UpdateProgress)) (sys.UpdateResult, error) {
	return s.update(c, p, f)
}
func (s scriptedOperations) Pull(c context.Context, i string, f func(docker.PullEvent)) error {
	return s.pull(c, i, f)
}
func (s scriptedOperations) Images(c context.Context, i []string) []docker.ImageStatus {
	return s.images(c, i)
}
func (s scriptedOperations) Recreate(c context.Context, i string) (docker.RecreateResult, error) {
	return s.recreate(c, i)
}

func unusedOperations(t *testing.T) scriptedOperations {
	t.Helper()
	return scriptedOperations{
		update: func(context.Context, sys.UpdateParams, func(sys.UpdateProgress)) (sys.UpdateResult, error) {
			t.Fatal("unexpected update")
			return sys.UpdateResult{}, nil
		},
		pull:   func(context.Context, string, func(docker.PullEvent)) error { t.Fatal("unexpected pull"); return nil },
		images: func(context.Context, []string) []docker.ImageStatus { t.Fatal("unexpected images"); return nil },
		recreate: func(context.Context, string) (docker.RecreateResult, error) {
			t.Fatal("unexpected recreate")
			return docker.RecreateResult{}, nil
		},
	}
}

func TestUpdateOperationProgressAndSingleTerminalReply(t *testing.T) {
	op := unusedOperations(t)
	op.update = func(ctx context.Context, p sys.UpdateParams, progress func(sys.UpdateProgress)) (sys.UpdateResult, error) {
		if p.URL != "https://local.invalid/agent" || p.SHA256 != "abc" {
			t.Fatalf("params=%#v", p)
		}
		progress(sys.UpdateProgress{Phase: "downloading", DownloadedBytes: 7, TotalBytes: 11})
		return sys.UpdateResult{OK: true, Version: p.Version, SHA256: p.SHA256}, nil
	}
	h := New("runner", t.TempDir())
	h.operations = op
	got := collectDispatch(h, context.Background(), Msg{ID: "u1", Method: "sys.update", Params: json.RawMessage(`{"url":"https://local.invalid/agent","sha256":"abc","version":"v2","progressStream":"up"}`)})
	if len(got) != 2 || got[0].Type != "stream" || got[1].Type != "res" || got[1].OK == nil || !*got[1].OK {
		t.Fatalf("messages=%#v", got)
	}
	raw, _ := base64.StdEncoding.DecodeString(got[0].Data)
	var event sys.UpdateProgress
	if err := json.Unmarshal(raw, &event); err != nil || event.Phase != "downloading" || event.DownloadedBytes != 7 {
		t.Fatalf("event=%#v err=%v", event, err)
	}
}

func TestImageOperationWireResults(t *testing.T) {
	op := unusedOperations(t)
	op.images = func(_ context.Context, names []string) []docker.ImageStatus {
		return []docker.ImageStatus{{Image: names[0], ID: "sha256:1"}}
	}
	h := New("runner", t.TempDir())
	h.operations = op
	got := collectDispatch(h, context.Background(), Msg{ID: "i1", Method: "docker.images", Params: json.RawMessage(`{"images":["repo:tag"]}`)})
	if len(got) != 1 || got[0].OK == nil || !*got[0].OK {
		t.Fatalf("messages=%#v", got)
	}
	var result []docker.ImageStatus
	if err := json.Unmarshal(got[0].Result, &result); err != nil || len(result) != 1 || result[0].ID != "sha256:1" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func TestRecreateCancellationHasOneErrorReply(t *testing.T) {
	op := unusedOperations(t)
	op.recreate = func(ctx context.Context, _ string) (docker.RecreateResult, error) {
		return docker.RecreateResult{}, ctx.Err()
	}
	h := New("runner", t.TempDir())
	h.operations = op
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := collectDispatch(h, ctx, Msg{ID: "r1", Method: "docker.recreate", Params: json.RawMessage(`{"image":"repo:tag"}`)})
	if len(got) != 1 || got[0].Error != context.Canceled.Error() {
		t.Fatalf("messages=%#v", got)
	}
}

func TestOperationFailureDoesNotEmitSuccessReply(t *testing.T) {
	op := unusedOperations(t)
	op.pull = func(context.Context, string, func(docker.PullEvent)) error { return errors.New("pull failed") }
	h := New("runner", t.TempDir())
	h.operations = op
	got := collectDispatch(h, context.Background(), Msg{ID: "p1", Method: "docker.pull", Params: json.RawMessage(`{"image":"repo:tag"}`)})
	if len(got) != 1 || got[0].OK == nil || *got[0].OK || got[0].Error != "pull failed" {
		t.Fatalf("messages=%#v", got)
	}
}

func TestLateProgressAfterTerminalReplyIsIgnored(t *testing.T) {
	op := unusedOperations(t)
	var retained func(docker.PullEvent)
	op.pull = func(_ context.Context, _ string, progress func(docker.PullEvent)) error {
		retained = progress
		progress(docker.PullEvent{Status: "first"})
		return nil
	}
	h := New("runner", t.TempDir())
	h.operations = op
	got := collectDispatch(h, context.Background(), Msg{ID: "late", Method: "docker.pull", Params: json.RawMessage(`{"image":"repo:tag","progressStream":"p"}`)})
	if len(got) != 2 || got[1].Type != "res" {
		t.Fatalf("messages=%#v", got)
	}
	retained(docker.PullEvent{Status: "too-late"})
	if len(got) != 2 {
		t.Fatalf("late progress emitted after reply: %#v", got)
	}
}

func TestProgressCleanupIsIdempotent(t *testing.T) {
	var got []Msg
	life := newProgressLifecycle(context.Background(), func(m Msg) { got = append(got, m) }, "p")
	life.close()
	life.close()
	life.emit(docker.PullEvent{Status: "late"})
	if len(got) != 0 {
		t.Fatalf("messages=%#v", got)
	}
}
