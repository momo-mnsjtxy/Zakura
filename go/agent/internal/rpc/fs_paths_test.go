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
