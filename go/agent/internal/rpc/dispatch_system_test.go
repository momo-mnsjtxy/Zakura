package rpc

import (
	"context"
	"encoding/json"
	"testing"

	"zakura.dev/agent/internal/docker"
)

type fakeSystemExecutor struct {
	infoCalls int
	pingCalls int
	kind      string
	root      string
	light     bool
}

func (f *fakeSystemExecutor) Info(kind, root string, light bool) any {
	f.infoCalls++
	f.kind = kind
	f.root = root
	f.light = light
	return map[string]any{"version": "test", "light": light}
}
func (f *fakeSystemExecutor) Ping() docker.Ping {
	f.pingCalls++
	return docker.Ping{OK: true, Version: "test-docker"}
}

func TestSystemInfoStrictDispatchAndSingleReply(t *testing.T) {
	fake := &fakeSystemExecutor{}
	h := New("computer", t.TempDir())
	h.system = fake
	got := collectDispatch(h, context.Background(), Msg{ID: "info", Method: "sys.info", Params: json.RawMessage(`{"light":true}`)})
	if len(got) != 1 || got[0].OK == nil || !*got[0].OK {
		t.Fatalf("messages=%#v", got)
	}
	if fake.infoCalls != 1 || fake.kind != "computer" || fake.root != h.StorageRoot || !fake.light {
		t.Fatalf("fake=%#v", fake)
	}
	var result map[string]any
	if err := json.Unmarshal(got[0].Result, &result); err != nil || result["version"] != "test" || result["light"] != true {
		t.Fatalf("result=%s err=%v", got[0].Result, err)
	}
}

func TestSystemStatusPingWireResult(t *testing.T) {
	fake := &fakeSystemExecutor{}
	h := New("runner", t.TempDir())
	h.system = fake
	got := collectDispatch(h, context.Background(), Msg{ID: "ping", Method: "docker.ping"})
	if len(got) != 1 || got[0].OK == nil || !*got[0].OK || fake.pingCalls != 1 {
		t.Fatalf("messages=%#v calls=%d", got, fake.pingCalls)
	}
	var result docker.Ping
	if err := json.Unmarshal(got[0].Result, &result); err != nil || !result.OK || result.Version != "test-docker" {
		t.Fatalf("result=%s err=%v", got[0].Result, err)
	}
}

func TestSystemMalformedParamsNeverExecute(t *testing.T) {
	for _, tc := range []struct {
		method string
		params json.RawMessage
	}{
		{"sys.info", json.RawMessage(`{"light":`)},
		{"sys.info", json.RawMessage(`{"light":"yes"}`)},
		{"docker.ping", json.RawMessage(`[`)},
		{"docker.ping", json.RawMessage(`42`)},
	} {
		fake := &fakeSystemExecutor{}
		h := New("runner", t.TempDir())
		h.system = fake
		got := collectDispatch(h, context.Background(), Msg{ID: "bad", Method: tc.method, Params: tc.params})
		if len(got) != 1 || got[0].OK == nil || *got[0].OK || got[0].Error == "" {
			t.Fatalf("%s(%s) messages=%#v", tc.method, tc.params, got)
		}
		if fake.infoCalls != 0 || fake.pingCalls != 0 {
			t.Fatalf("executor called for %s(%s): %#v", tc.method, tc.params, fake)
		}
	}
}

func TestSystemCancellationPreventsProbe(t *testing.T) {
	for _, method := range []string{"sys.info", "docker.ping"} {
		fake := &fakeSystemExecutor{}
		h := New("runner", t.TempDir())
		h.system = fake
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		got := collectDispatch(h, ctx, Msg{ID: "cancel", Method: method, Params: json.RawMessage(`{}`)})
		if len(got) != 1 || got[0].Error != context.Canceled.Error() {
			t.Fatalf("%s messages=%#v", method, got)
		}
		if fake.infoCalls != 0 || fake.pingCalls != 0 {
			t.Fatalf("executor called for canceled %s", method)
		}
	}
}
