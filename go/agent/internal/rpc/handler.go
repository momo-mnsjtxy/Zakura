package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"

	"zakura.dev/agent/internal/host"
	"zakura.dev/agent/internal/sys"
)

type Handler struct {
	Kind        string
	StorageRoot string
	jobs        *host.Registry
	ptys        map[string]*host.LiveStream
	docker      dockerExecutor
	mu          sync.Mutex
}

func New(kind, storageRoot string) *Handler {
	return &Handler{
		Kind:        kind,
		StorageRoot: storageRoot,
		jobs:        host.NewRegistry(),
		ptys:        map[string]*host.LiveStream{},
		docker:      productionDockerExecutor{},
	}
}

func (h *Handler) workspace(spaceID string) string {
	return host.SpaceWorkspace(h.StorageRoot, spaceID)
}

func (h *Handler) Dispatch(ctx context.Context, msg Msg, send func(Msg)) {
	if handled, result, err := h.dispatchSystem(ctx, msg, send); handled {
		h.reply(msg, result, err, send)
		return
	}
	if handled, result, err := h.dispatchFilesystem(msg); handled {
		h.reply(msg, result, err, send)
		return
	}
	if handled, result, err := h.dispatchHost(msg, send); handled {
		h.reply(msg, result, err, send)
		return
	}
	if handled, result, err := h.dispatchDocker(ctx, msg, send); handled {
		h.reply(msg, result, err, send)
		return
	}
	send(Err(msg.ID, "未知方法: "+msg.Method))
}

func (h *Handler) reply(msg Msg, result any, err error, send func(Msg)) {
	if err != nil {
		message := err.Error()
		if strings.HasPrefix(msg.Method, "host.fs.") {
			var p spacePath
			_ = json.Unmarshal(msg.Params, &p)
			message = host.ScrubHostPathsInMessage(h.rootOf(p), message)
		}
		send(Err(msg.ID, message))
		return
	}
	send(Ok(msg.ID, result))
	if update, ok := result.(sys.UpdateResult); ok {
		update.AfterReply()
	}
}

type spacePath struct {
	SpaceID string `json:"spaceId"`
	Path    string `json:"path"`
}

func (h *Handler) rootOf(p spacePath) string {
	if p.SpaceID != "" {
		return h.workspace(p.SpaceID)
	}
	return h.StorageRoot
}

// Called after the filesystem operation has validated the path with Jail.
func (h *Handler) apiPath(p spacePath, path string) string {
	root := h.rootOf(p)
	abs, err := host.Jail(root, path)
	if err != nil {
		return path
	}
	return host.WorkspacePath(root, abs)
}

func (h *Handler) fsStat(raw json.RawMessage) (any, error) {
	var p spacePath
	_ = json.Unmarshal(raw, &p)
	return host.Stat(h.rootOf(p), p.Path)
}

func (h *Handler) fsList(raw json.RawMessage) (any, error) {
	var p spacePath
	_ = json.Unmarshal(raw, &p)
	ents, err := host.List(h.rootOf(p), p.Path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": h.apiPath(p, p.Path), "entries": ents}, nil
}

func (h *Handler) fsRead(raw json.RawMessage) (any, error) {
	var p struct {
		spacePath
		Max int64 `json:"max"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.Max == 0 {
		p.Max = 8 << 20
	}
	b, err := host.ReadFile(h.rootOf(p.spacePath), p.Path, p.Max)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path":    h.apiPath(p.spacePath, p.Path),
		"content": string(b),
		"base64":  base64.StdEncoding.EncodeToString(b),
		"size":    len(b),
	}, nil
}

func (h *Handler) fsWrite(raw json.RawMessage) (any, error) {
	var p struct {
		spacePath
		Content string `json:"content"`
		Base64  string `json:"base64"`
	}
	_ = json.Unmarshal(raw, &p)
	data := []byte(p.Content)
	if p.Base64 != "" {
		var err error
		data, err = base64.StdEncoding.DecodeString(p.Base64)
		if err != nil {
			return nil, err
		}
	}
	rev, err := host.WriteFile(h.rootOf(p.spacePath), p.Path, data)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": h.apiPath(p.spacePath, p.Path), "ok": true, "revision": rev}, nil
}

func (h *Handler) fsMkdir(raw json.RawMessage) (any, error) {
	var p spacePath
	_ = json.Unmarshal(raw, &p)
	root := h.rootOf(p)
	if err := host.Mkdir(root, p.Path); err != nil {
		return nil, err
	}
	abs, err := host.Jail(root, p.Path)
	if err != nil {
		abs = root
	}
	return map[string]any{"path": h.apiPath(p, p.Path), "ok": true, "abs": abs}, nil
}

func (h *Handler) fsRemove(raw json.RawMessage) (any, error) {
	var p struct {
		spacePath
		Recursive bool `json:"recursive"`
	}
	_ = json.Unmarshal(raw, &p)
	if err := host.Remove(h.rootOf(p.spacePath), p.Path, p.Recursive); err != nil {
		return nil, err
	}
	return map[string]any{"path": h.apiPath(p.spacePath, p.Path), "ok": true}, nil
}

func (h *Handler) fsRename(raw json.RawMessage) (any, error) {
	var p struct {
		spacePath
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	_ = json.Unmarshal(raw, &p)
	if err := host.Rename(h.rootOf(p.spacePath), p.OldPath, p.NewPath); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "path": h.apiPath(p.spacePath, p.NewPath)}, nil
}
