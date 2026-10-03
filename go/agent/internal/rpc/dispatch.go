package rpc

import (
	"context"
	"encoding/json"

	"zakura.dev/agent/internal/sys"
)

// Method families are dispatched independently so protocol growth does not
// turn Handler.Dispatch into one untestable, security-sensitive switch.
func (h *Handler) dispatchSystem(ctx context.Context, msg Msg, send func(Msg)) (bool, any, error) {
	switch msg.Method {
	case "sys.info":
		var p struct {
			Light bool `json:"light"`
		}
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			return true, nil, err
		}
		if p.Light {
			return true, sys.VersionInfo(), nil
		}
		return true, sys.Collect(h.Kind, h.StorageRoot), nil
	default:
		return false, nil, nil
	}
}
