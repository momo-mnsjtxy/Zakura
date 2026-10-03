package rpc

import (
	"context"
	"encoding/json"
	"errors"

	"zakura.dev/agent/internal/docker"
	"zakura.dev/agent/internal/sys"
)

// systemExecutor separates host-status collection from RPC routing. Full info
// may probe the local machine; tests substitute it and perform no such probes.
type systemExecutor interface {
	Info(kind, storageRoot string, light bool) any
	Ping() docker.Ping
}

type productionSystemExecutor struct{}

func (productionSystemExecutor) Info(kind, storageRoot string, light bool) any {
	if light {
		return sys.VersionInfo()
	}
	return sys.Collect(kind, storageRoot)
}
func (productionSystemExecutor) Ping() docker.Ping { return docker.Probe() }

func (h *Handler) dispatchSystem(ctx context.Context, msg Msg, _ func(Msg)) (bool, any, error) {
	if !isSystemMethod(msg.Method) {
		return false, nil, nil
	}
	if err := ctx.Err(); err != nil {
		return true, nil, err
	}
	if len(msg.Params) != 0 && !json.Valid(msg.Params) {
		return true, nil, errors.New("invalid JSON params")
	}
	switch msg.Method {
	case "sys.info":
		var p struct {
			Light bool `json:"light"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		return true, h.system.Info(h.Kind, h.StorageRoot, p.Light), nil
	case "docker.ping":
		// Params are intentionally ignored for compatibility, but when present
		// must still be a JSON object rather than malformed control input.
		if len(msg.Params) != 0 {
			var p struct{}
			if err := decodeParams(msg.Params, &p); err != nil {
				return true, nil, err
			}
		}
		return true, h.system.Ping(), nil
	}
	panic("unreachable")
}

func isSystemMethod(method string) bool {
	switch method {
	case "sys.info", "docker.ping":
		return true
	default:
		return false
	}
}
