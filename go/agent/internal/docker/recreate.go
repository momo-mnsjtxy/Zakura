package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type RecreateResult struct {
	Image     string          `json:"image"`
	Recreated []ContainerInfo `json:"recreated"`
	Skipped   int             `json:"skipped"`
	Failed    []string        `json:"failed,omitempty"`
}

type recreateExecutor interface {
	currentImage(context.Context, string) (string, error)
	list(context.Context) ([]ContainerInfo, error)
	containerImage(context.Context, string) (string, error)
	spec(context.Context, string) (RunSpec, error)
	removeName(context.Context, string) error
	rename(context.Context, string, string) error
	run(context.Context, RunSpec) (ContainerInfo, error)
}

type productionRecreateExecutor struct{}

const recreateCleanupTimeout = 10 * time.Second

func (productionRecreateExecutor) currentImage(ctx context.Context, image string) (string, error) {
	id, _, err := imageID(ctx, image)
	return id, err
}
func (productionRecreateExecutor) list(ctx context.Context) ([]ContainerInfo, error) {
	return List(ctx, "")
}
func (productionRecreateExecutor) containerImage(ctx context.Context, id string) (string, error) {
	return containerImageID(ctx, id)
}
func (productionRecreateExecutor) spec(ctx context.Context, id string) (RunSpec, error) {
	return specFromContainer(ctx, id)
}
func (productionRecreateExecutor) removeName(ctx context.Context, name string) error {
	return dockerCommands.Run(ctx, "rm", "-f", name)
}
func (productionRecreateExecutor) rename(ctx context.Context, from, to string) error {
	return dockerCommands.Run(ctx, "rename", from, to)
}
func (productionRecreateExecutor) run(ctx context.Context, spec RunSpec) (ContainerInfo, error) {
	return Run(ctx, spec)
}

func RecreateStale(ctx context.Context, image string) (RecreateResult, error) {
	return recreateStale(ctx, image, productionRecreateExecutor{})
}

func recreateStale(ctx context.Context, image string, ops recreateExecutor) (RecreateResult, error) {
	res := RecreateResult{Image: image}
	if image == "" {
		return res, fmt.Errorf("image 不能为空")
	}
	cur, err := ops.currentImage(ctx, image)
	if err != nil {
		return res, err
	}
	list, err := ops.list(ctx)
	if err != nil {
		return res, err
	}
	for _, c := range list {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if !isZakura(c.Labels) || !imageRefMatch(c.Image, image) {
			res.Skipped++
			continue
		}
		bak := c.Name + ".bak"
		if c.Name != "" {
			if err := ops.removeName(ctx, bak); err != nil {
				res.Failed = append(res.Failed, c.Name+": cleanup backup: "+err.Error())
				continue
			}
		}
		rawID, _ := ops.containerImage(ctx, c.DockerID)
		if rawID == cur {
			res.Skipped++
			continue
		}
		spec, err := ops.spec(ctx, c.DockerID)
		if err != nil {
			res.Failed = append(res.Failed, c.Name+": "+err.Error())
			continue
		}
		spec.Image = image
		renamed := false
		if spec.Name != "" {
			if err := ops.rename(ctx, spec.Name, bak); err != nil {
				res.Failed = append(res.Failed, c.Name+": rename backup: "+err.Error())
				continue
			}
			renamed = true
		}
		rollback := func(cause error) error {
			if !renamed {
				return cause
			}
			cleanupCtx, cancel := context.WithTimeout(context.Background(), recreateCleanupTimeout)
			defer cancel()
			_ = ops.removeName(cleanupCtx, spec.Name)
			if restoreErr := ops.rename(cleanupCtx, bak, spec.Name); restoreErr != nil {
				return fmt.Errorf("%w; rollback failed: %v", cause, restoreErr)
			}
			renamed = false
			return cause
		}
		if err := ctx.Err(); err != nil {
			res.Failed = append(res.Failed, c.Name+": "+rollback(err).Error())
			continue
		}
		info, err := ops.run(ctx, spec)
		if err != nil {
			res.Failed = append(res.Failed, c.Name+": "+rollback(err).Error())
			continue
		}
		if renamed {
			if err := ops.removeName(ctx, bak); err != nil {
				res.Recreated = append(res.Recreated, info)
				res.Failed = append(res.Failed, c.Name+": cleanup backup: "+err.Error())
				continue
			}
			renamed = false
		}
		res.Recreated = append(res.Recreated, info)
	}
	return res, nil
}

func specFromContainer(ctx context.Context, id string) (RunSpec, error) {
	out, err := dockerCommands.CombinedOutput(ctx, "inspect", id)
	if err != nil {
		return RunSpec{}, fmt.Errorf("inspect: %s", strings.TrimSpace(string(out)))
	}
	return specFromInspectJSON(out)
}

func specFromInspectJSON(raw []byte) (RunSpec, error) {
	var arr []inspectBlob
	if err := json.Unmarshal(raw, &arr); err != nil || len(arr) == 0 {
		return RunSpec{}, fmt.Errorf("解析 inspect 失败")
	}
	c := arr[0]
	spec := RunSpec{
		Name:       strings.TrimPrefix(c.Name, "/"),
		Image:      c.Config.Image,
		Command:    c.Config.Cmd,
		WorkingDir: c.Config.WorkingDir,
		Labels:     c.Config.Labels,
		Privileged: c.HostConfig.Privileged,
		Restart:    c.HostConfig.RestartPolicy.Name,
		Env:        map[string]string{},
	}
	net := c.HostConfig.NetworkMode
	if net != "" && net != "default" && net != "bridge" && net != "host" {
		spec.Network = net
	}
	for _, e := range c.Config.Env {
		k, v, ok := strings.Cut(e, "=")
		if ok {
			spec.Env[k] = v
		}
	}
	for k, binds := range c.HostConfig.PortBindings {
		var cp int
		var proto string
		fmt.Sscanf(k, "%d/%s", &cp, &proto)
		p := Port{ContainerPort: cp, Protocol: proto}
		if len(binds) > 0 {
			p.HostPort, _ = strconv.Atoi(binds[0].HostPort)
			p.HostIP = binds[0].HostIP
		}
		spec.Ports = append(spec.Ports, p)
	}
	for _, m := range c.Mounts {
		v := Volume{ContainerPath: m.Destination, ReadOnly: !m.RW}
		if m.Type == "volume" {
			v.VolumeName = m.Name
		} else {
			v.HostPath = m.Source
		}
		spec.Volumes = append(spec.Volumes, v)
	}
	return spec, nil
}

type inspectBlob struct {
	Name   string `json:"Name"`
	Config struct {
		Image      string            `json:"Image"`
		Env        []string          `json:"Env"`
		Labels     map[string]string `json:"Labels"`
		Cmd        []string          `json:"Cmd"`
		WorkingDir string            `json:"WorkingDir"`
	} `json:"Config"`
	HostConfig struct {
		Privileged    bool   `json:"Privileged"`
		NetworkMode   string `json:"NetworkMode"`
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
		PortBindings map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"PortBindings"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
}
