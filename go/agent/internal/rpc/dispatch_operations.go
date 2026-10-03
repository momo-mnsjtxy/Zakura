package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"

	"zakura.dev/agent/internal/docker"
	"zakura.dev/agent/internal/sys"
)

// operationExecutor isolates long-running update and image operations from
// transport dispatch, allowing lifecycle tests without external side effects.
type operationExecutor interface {
	Update(context.Context, sys.UpdateParams, func(sys.UpdateProgress)) (sys.UpdateResult, error)
	Pull(context.Context, string, func(docker.PullEvent)) error
	Images(context.Context, []string) []docker.ImageStatus
	Recreate(context.Context, string) (docker.RecreateResult, error)
}

type productionOperationExecutor struct{}

func (productionOperationExecutor) Update(ctx context.Context, p sys.UpdateParams, progress func(sys.UpdateProgress)) (sys.UpdateResult, error) {
	return sys.Apply(ctx, p, progress)
}
func (productionOperationExecutor) Pull(ctx context.Context, image string, progress func(docker.PullEvent)) error {
	return docker.PullWithProgress(ctx, image, progress)
}
func (productionOperationExecutor) Images(ctx context.Context, images []string) []docker.ImageStatus {
	return docker.InspectImages(ctx, images)
}
func (productionOperationExecutor) Recreate(ctx context.Context, image string) (docker.RecreateResult, error) {
	return docker.RecreateStale(ctx, image)
}

func (h *Handler) dispatchOperation(ctx context.Context, msg Msg, send func(Msg)) (bool, any, error) {
	if !isOperationMethod(msg.Method) {
		return false, nil, nil
	}
	if len(msg.Params) != 0 && !json.Valid(msg.Params) {
		return true, nil, errors.New("invalid JSON params")
	}
	switch msg.Method {
	case "sys.update":
		var p sys.UpdateParams
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		var progress func(sys.UpdateProgress)
		if p.ProgressStream != "" {
			life := newProgressLifecycle(ctx, send, p.ProgressStream)
			defer life.close()
			progress = func(event sys.UpdateProgress) { life.emit(event) }
		}
		result, err := h.operations.Update(ctx, p, progress)
		return true, result, err
	case "docker.pull":
		var p struct {
			Image          string `json:"image"`
			ProgressStream string `json:"progressStream"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		var progress func(docker.PullEvent)
		if p.ProgressStream != "" {
			life := newProgressLifecycle(ctx, send, p.ProgressStream)
			defer life.close()
			progress = func(event docker.PullEvent) { life.emit(event) }
		}
		err := h.operations.Pull(ctx, p.Image, progress)
		return true, map[string]string{"image": p.Image}, err
	case "docker.images":
		var p struct {
			Images []string `json:"images"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		return true, h.operations.Images(ctx, p.Images), nil
	case "docker.recreate":
		var p struct {
			Image string `json:"image"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		result, err := h.operations.Recreate(ctx, p.Image)
		return true, result, err
	}
	panic("unreachable")
}

type progressLifecycle struct {
	mu     sync.Mutex
	ctx    context.Context
	send   func(Msg)
	stream string
	closed bool
}

func newProgressLifecycle(ctx context.Context, send func(Msg), stream string) *progressLifecycle {
	return &progressLifecycle{ctx: ctx, send: send, stream: stream}
}

func (p *progressLifecycle) emit(event any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.ctx.Err() != nil {
		return
	}
	data, _ := json.Marshal(event)
	p.send(Msg{Type: "stream", Stream: p.stream, Chan: "progress", Data: base64.StdEncoding.EncodeToString(data)})
}

func (p *progressLifecycle) close() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
}

func isOperationMethod(method string) bool {
	switch method {
	case "sys.update", "docker.pull", "docker.images", "docker.recreate":
		return true
	default:
		return false
	}
}
