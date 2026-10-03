package docker

import (
	"bytes"
	"context"
	"io"
	"os/exec"
)

type commandExecutor interface {
	CombinedOutput(context.Context, ...string) ([]byte, error)
	Run(context.Context, ...string) error
	Exec(context.Context, []string) (stdout, stderr string, code int, err error)
	Pull(context.Context, []string, io.Writer, bool) error
}

type osCommandExecutor struct{}

func (osCommandExecutor) command(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, dockerBin(), args...)
}
func (e osCommandExecutor) CombinedOutput(ctx context.Context, args ...string) ([]byte, error) {
	return e.command(ctx, args...).CombinedOutput()
}
func (e osCommandExecutor) Run(ctx context.Context, args ...string) error {
	return e.command(ctx, args...).Run()
}
func (e osCommandExecutor) Exec(ctx context.Context, args []string) (string, string, int, error) {
	cmd := e.command(ctx, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if err == nil {
		return stdout.String(), stderr.String(), 0, nil
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return stdout.String(), stderr.String(), exit.ExitCode(), nil
	}
	return stdout.String(), stderr.String(), 1, err
}
func (e osCommandExecutor) Pull(ctx context.Context, args []string, output io.Writer, progress bool) error {
	cmd := e.command(ctx, args...)
	cmd.Stdout, cmd.Stderr = output, output
	if progress {
		return runPullCommand(cmd, output)
	}
	return cmd.Run()
}

var dockerCommands commandExecutor = osCommandExecutor{}
