package rpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zakura.dev/agent/internal/host"
)

func TestWorkspaceFsPathAliases(t *testing.T) {
	storage := t.TempDir()
	h := New("computer", storage)
	root := host.SpaceWorkspace(storage, "a1")
	call := func(method, path string) Msg {
		t.Helper()
		params, _ := json.Marshal(map[string]string{"spaceId": "a1", "path": path, "content": "hello"})
		var response Msg
		h.Dispatch(context.Background(), Msg{ID: "fs", Method: method, Params: params}, func(msg Msg) { response = msg })
		return response
	}
	for _, path := range []string{"shots/a.txt", "/shots/a.txt", "/workspace/shots/a.txt", filepath.Join(root, "shots", "a.txt")} {
		for _, method := range []string{"host.fs.write", "host.fs.read", "host.fs.stat"} {
			response := call(method, path)
			if response.Error != "" {
				t.Fatalf("%s(%q): %s", method, path, response.Error)
			}
			var result struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(response.Result, &result); err != nil || result.Path != "/shots/a.txt" {
				t.Fatalf("path must round-trip without a host root: %s (%v)", response.Result, err)
			}
		}
		data, err := os.ReadFile(filepath.Join(root, "shots", "a.txt"))
		if err != nil || string(data) != "hello" {
			t.Fatalf("alias did not reach the workspace file: %q, %v", data, err)
		}
	}
	for _, path := range []string{"/workspace/missing.txt", root + "/../outside"} {
		response := call("host.fs.read", path)
		if response.Error == "" || strings.Contains(response.Error, storage) {
			t.Fatalf("expected a scrubbed error for %q, got %q", path, response.Error)
		}
	}
}

func TestWorkspaceFsRejectsSpaceIDTraversalAndRootOverride(t *testing.T) {
	storage := t.TempDir()
	h := New("computer", storage)
	outside := filepath.Join(storage, "outside.txt")
	params, _ := json.Marshal(map[string]string{
		"spaceId": "../../..",
		"root":    filepath.Dir(outside),
		"path":    filepath.Base(outside),
		"content": "escaped",
	})
	var response Msg
	h.Dispatch(context.Background(), Msg{ID: "fs", Method: "host.fs.write", Params: params}, func(msg Msg) { response = msg })
	if response.Error != "" {
		t.Fatalf("safe invalid workspace should remain usable: %s", response.Error)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("untrusted spaceId/root escaped storage jail: %v", err)
	}
	safe := filepath.Join(storage, "spaces", "_invalid-space-id_", "workspace", "outside.txt")
	if data, err := os.ReadFile(safe); err != nil || string(data) != "escaped" {
		t.Fatalf("invalid ID was not contained in quarantine workspace: %q, %v", data, err)
	}
}

func TestFilesystemDispatchAliasesAndJailMatrix(t *testing.T) {
	storage := t.TempDir()
	h := New("computer", storage)
	root := host.SpaceWorkspace(storage, "space-1")
	aliases := []string{
		"nested/file.txt",
		"/nested/file.txt",
		"/workspace/nested/file.txt",
		`\workspace\nested\file.txt`,
		filepath.Join(root, "nested", "file.txt"),
	}
	for _, path := range aliases {
		params, _ := json.Marshal(map[string]string{"spaceId": "space-1", "path": path, "content": "ok"})
		var got []Msg
		h.Dispatch(context.Background(), Msg{ID: "write", Method: "host.fs.write", Params: params}, func(msg Msg) { got = append(got, msg) })
		if len(got) != 1 || got[0].OK == nil || !*got[0].OK {
			t.Fatalf("write(%q) messages=%#v", path, got)
		}
		var result struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(got[0].Result, &result); err != nil || result.Path != "/nested/file.txt" {
			t.Fatalf("write(%q) result=%s err=%v", path, got[0].Result, err)
		}
	}
	for _, path := range []string{"../outside", "nested/../../outside", "bad\x00name"} {
		params, _ := json.Marshal(map[string]string{"spaceId": "space-1", "path": path, "content": "escaped"})
		var got []Msg
		h.Dispatch(context.Background(), Msg{ID: "bad", Method: "host.fs.write", Params: params}, func(msg Msg) { got = append(got, msg) })
		if len(got) != 1 || got[0].OK == nil || *got[0].OK || got[0].Error == "" || strings.Contains(got[0].Error, storage) {
			t.Fatalf("write(%q) messages=%#v", path, got)
		}
	}
	if _, err := os.Stat(filepath.Join(storage, "outside")); !os.IsNotExist(err) {
		t.Fatalf("jail escape created outside file: %v", err)
	}
}

func TestFilesystemDispatchCancellationPreventsMutation(t *testing.T) {
	storage := t.TempDir()
	h := New("computer", storage)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	params := json.RawMessage(`{"path":"cancelled.txt","content":"must not exist"}`)
	var got []Msg
	h.Dispatch(ctx, Msg{ID: "cancel", Method: "host.fs.write", Params: params}, func(msg Msg) { got = append(got, msg) })
	if len(got) != 1 || got[0].Error != context.Canceled.Error() {
		t.Fatalf("messages=%#v", got)
	}
	if _, err := os.Stat(filepath.Join(storage, "cancelled.txt")); !os.IsNotExist(err) {
		t.Fatalf("canceled write mutated filesystem: %v", err)
	}
}

func TestFilesystemCleanupOperationIsIdempotent(t *testing.T) {
	storage := t.TempDir()
	h := New("computer", storage)
	if err := os.MkdirAll(filepath.Join(storage, "cleanup"), 0o755); err != nil {
		t.Fatal(err)
	}
	params := json.RawMessage(`{"path":"cleanup","recursive":true}`)
	for i := 0; i < 2; i++ {
		var got []Msg
		h.Dispatch(context.Background(), Msg{ID: "remove", Method: "host.fs.remove", Params: params}, func(msg Msg) { got = append(got, msg) })
		if len(got) != 1 || got[0].OK == nil || !*got[0].OK {
			t.Fatalf("attempt %d messages=%#v", i, got)
		}
	}
}

func TestFilesystemMalformedParamsReplyOnceWithoutMutation(t *testing.T) {
	storage := t.TempDir()
	h := New("computer", storage)
	for _, params := range []json.RawMessage{json.RawMessage(`{"path":`), json.RawMessage(`{"path":42,"content":"x"}`)} {
		var got []Msg
		h.Dispatch(context.Background(), Msg{ID: "bad", Method: "host.fs.write", Params: params}, func(msg Msg) { got = append(got, msg) })
		if len(got) != 1 || got[0].OK == nil || *got[0].OK || got[0].Error == "" {
			t.Fatalf("params=%s messages=%#v", params, got)
		}
	}
	entries, err := os.ReadDir(storage)
	if err != nil || len(entries) != 0 {
		t.Fatalf("malformed request mutated storage: entries=%v err=%v", entries, err)
	}
}
