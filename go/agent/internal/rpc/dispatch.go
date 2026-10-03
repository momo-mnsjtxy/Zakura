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

func (h *Handler) dispatchFilesystem(msg Msg) (bool, any, error) {
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
	default:
		return false, nil, nil
	}
	return true, result, err
}
