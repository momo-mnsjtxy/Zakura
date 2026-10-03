package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"zakura.dev/agent/internal/docker"
	"zakura.dev/agent/internal/host"
)

type dockerExecutor interface {
	Run(context.Context, docker.RunSpec) (docker.ContainerInfo, error)
	Stop(context.Context, string, bool) error
	Inspect(context.Context, string) (docker.ContainerInfo, error)
	Exec(context.Context, string, []string, string, map[string]string) (string, string, int, error)
	Logs(context.Context, string, int) (string, error)
	Copy(context.Context, string, string) error
	List(context.Context, string) ([]docker.ContainerInfo, error)
}

type productionDockerExecutor struct{}

func (productionDockerExecutor) Run(ctx context.Context, spec docker.RunSpec) (docker.ContainerInfo, error) {
	return docker.Run(ctx, spec)
}
func (productionDockerExecutor) Stop(ctx context.Context, id string, remove bool) error {
	return docker.Stop(ctx, id, remove)
}
func (productionDockerExecutor) Inspect(ctx context.Context, id string) (docker.ContainerInfo, error) {
	return docker.Inspect(ctx, id)
}
func (productionDockerExecutor) Exec(ctx context.Context, id string, command []string, wd string, env map[string]string) (string, string, int, error) {
	return docker.Exec(ctx, id, command, wd, env)
}
func (productionDockerExecutor) Logs(ctx context.Context, id string, tail int) (string, error) {
	return docker.Logs(ctx, id, tail)
}
func (productionDockerExecutor) Copy(ctx context.Context, src, dest string) error {
	return docker.Copy(ctx, src, dest)
}
func (productionDockerExecutor) List(ctx context.Context, label string) ([]docker.ContainerInfo, error) {
	return docker.List(ctx, label)
}
func (h *Handler) dispatchDocker(ctx context.Context, msg Msg, send func(Msg)) (bool, any, error) {
	if !isDockerMethod(msg.Method) {
		return false, nil, nil
	}
	if len(msg.Params) != 0 && !json.Valid(msg.Params) {
		return true, nil, errors.New("invalid JSON params")
	}
	var result any
	var err error
	switch msg.Method {
	case "docker.run":
		var p docker.RunSpec
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		result, err = h.docker.Run(ctx, p)
	case "docker.stop":
		var p struct {
			ID     string `json:"id"`
			Remove bool   `json:"remove"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		err = h.docker.Stop(ctx, p.ID, p.Remove)
		result = map[string]bool{"ok": err == nil}
	case "docker.inspect":
		var p struct {
			ID string `json:"id"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		result, err = h.docker.Inspect(ctx, p.ID)
	case "docker.exec":
		var p struct {
			ID         string            `json:"id"`
			Command    []string          `json:"command"`
			WorkingDir string            `json:"workingDir"`
			Env        map[string]string `json:"env"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		var out, errout string
		var code int
		out, errout, code, err = h.docker.Exec(ctx, p.ID, p.Command, p.WorkingDir, p.Env)
		if err == nil {
			result = map[string]any{"exitCode": code, "stdout": out, "stderr": errout}
		}
	case "docker.logs":
		var p struct {
			ID   string `json:"id"`
			Tail int    `json:"tail"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		if p.Tail == 0 {
			p.Tail = 200
		}
		var logs string
		logs, err = h.docker.Logs(ctx, p.ID, p.Tail)
		result = map[string]string{"logs": logs}
	case "docker.copy":
		var p struct {
			Src  string `json:"src"`
			Dest string `json:"dest"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		err = h.docker.Copy(ctx, p.Src, p.Dest)
		result = map[string]bool{"ok": err == nil}
	case "docker.list":
		var p struct {
			Label string `json:"label"`
		}
		if err := decodeParams(msg.Params, &p); err != nil {
			return true, nil, err
		}
		result, err = h.docker.List(ctx, p.Label)
	case "docker.exec.start":
		result, err = h.dockerStdioStart(msg.Params, send)
	case "docker.attach":
		result, err = h.dockerAttach(msg.Params, send)
	case "docker.exec.write":
		err = h.ptyWrite(msg.Params)
		result = map[string]bool{"ok": err == nil}
	case "docker.exec.close":
		err = h.ptyClose(msg.Params)
		result = map[string]bool{"ok": true}
	}
	return true, result, err
}

func isDockerMethod(method string) bool {
	switch method {
	case "docker.run", "docker.stop", "docker.inspect",
		"docker.exec", "docker.logs", "docker.copy", "docker.list",
		"docker.exec.start", "docker.attach", "docker.exec.write", "docker.exec.close":
		return true
	default:
		return false
	}
}

func (h *Handler) dockerStdioStart(raw json.RawMessage, send func(Msg)) (any, error) {
	if err := docker.Require(); err != nil {
		return nil, err
	}
	var p struct {
		ID         string            `json:"id"`
		Command    []string          `json:"command"`
		WorkingDir string            `json:"workingDir"`
		Env        map[string]string `json:"env"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.ID == "" || len(p.Command) == 0 {
		return nil, fmt.Errorf("id 与 command 必填")
	}
	sess, err := host.StartDockerExec(p.ID, p.Command, p.WorkingDir, p.Env)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.ptys[sess.ID] = sess
	h.mu.Unlock()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "stdout", Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "exit"})
				return
			}
		}
	}()
	return map[string]any{"id": sess.ID, "mode": sess.Mode}, nil
}

func (h *Handler) dockerAttach(raw json.RawMessage, send func(Msg)) (any, error) {
	if err := docker.Require(); err != nil {
		return nil, err
	}
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.ID == "" {
		return nil, fmt.Errorf("id 必填")
	}
	sess, err := host.StartDockerAttach(p.ID)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.ptys[sess.ID] = sess
	h.mu.Unlock()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "stdout", Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "exit"})
				return
			}
		}
	}()
	return map[string]any{"id": sess.ID, "mode": sess.Mode}, nil
}
