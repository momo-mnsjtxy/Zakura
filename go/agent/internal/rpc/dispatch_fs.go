package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"zakura.dev/agent/internal/host"
)

func (h *Handler) dispatchFilesystem(ctx context.Context, msg Msg) (bool, any, error) {
	if !isFilesystemMethod(msg.Method) {
		return false, nil, nil
	}
	if err := ctx.Err(); err != nil {
		return true, nil, err
	}
	if len(msg.Params) != 0 && !json.Valid(msg.Params) {
		return true, nil, errors.New("invalid JSON params")
	}
	var result any
	var err error
	switch msg.Method {
	case "host.fs.stat":
		result, err = h.fsStat(msg.Params)
	case "host.fs.list":
		result, err = h.fsList(msg.Params)
	case "host.fs.read":
		result, err = h.fsRead(msg.Params)
	case "host.fs.write":
		result, err = h.fsWrite(msg.Params)
	case "host.fs.mkdir":
		result, err = h.fsMkdir(msg.Params)
	case "host.fs.remove":
		result, err = h.fsRemove(msg.Params)
	case "host.fs.rename":
		result, err = h.fsRename(msg.Params)
	}
	return true, result, err
}

func isFilesystemMethod(method string) bool {
	switch method {
	case "host.fs.stat", "host.fs.list", "host.fs.read", "host.fs.write", "host.fs.mkdir", "host.fs.remove", "host.fs.rename":
		return true
	default:
		return false
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
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
	return host.Stat(h.rootOf(p), p.Path)
}

func (h *Handler) fsList(raw json.RawMessage) (any, error) {
	var p spacePath
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
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
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
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
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
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
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
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
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
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
	if err := decodeParams(raw, &p); err != nil {
		return nil, err
	}
	if err := host.Rename(h.rootOf(p.spacePath), p.OldPath, p.NewPath); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "path": h.apiPath(p.spacePath, p.NewPath)}, nil
}
