package rpc

import (
	"context"
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
	operations  operationExecutor
	system      systemExecutor
	mu          sync.Mutex
}

func New(kind, storageRoot string) *Handler {
	return &Handler{
		Kind:        kind,
		StorageRoot: storageRoot,
		jobs:        host.NewRegistry(),
		ptys:        map[string]*host.LiveStream{},
		docker:      productionDockerExecutor{},
		operations:  productionOperationExecutor{},
		system:      productionSystemExecutor{},
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
	if handled, result, err := h.dispatchOperation(ctx, msg, send); handled {
		h.reply(msg, result, err, send)
		return
	}
	if handled, result, err := h.dispatchFilesystem(ctx, msg); handled {
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
