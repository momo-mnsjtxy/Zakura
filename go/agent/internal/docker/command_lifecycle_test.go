package docker

import (
	"context"
	"io"
	"strings"
	"testing"
)

type fakeCommandExecutor struct {
	calls    []string
	combined func([]string) ([]byte, error)
	run      func([]string) error
	pull     func([]string, io.Writer, bool) error
}

func (f *fakeCommandExecutor) CombinedOutput(_ context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	return f.combined(args)
}
func (f *fakeCommandExecutor) Run(_ context.Context, args ...string) error {
	f.calls = append(f.calls, strings.Join(args, " "))
	if f.run != nil {
		return f.run(args)
	}
	return nil
}
func (f *fakeCommandExecutor) Exec(_ context.Context, args []string) (string, string, int, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	return "out", "err", 7, nil
}
func (f *fakeCommandExecutor) Pull(_ context.Context, args []string, w io.Writer, progress bool) error {
	f.calls = append(f.calls, strings.Join(args, " "))
	return f.pull(args, w, progress)
}

func withFakeCommands(t *testing.T, fake commandExecutor) {
	t.Helper()
	previous := dockerCommands
	dockerCommands = fake
	t.Cleanup(func() { dockerCommands = previous })
}

func TestDockerCommandAdapterPreservesProbeStopAndExecArgs(t *testing.T) {
	fake := &fakeCommandExecutor{combined: func(args []string) ([]byte, error) { return []byte("27.1\n"), nil }}
	withFakeCommands(t, fake)
	if got := Probe(); !got.OK || got.Version != "27.1" {
		t.Fatalf("probe=%#v", got)
	}
	if err := Stop(context.Background(), "container-1", true); err != nil {
		t.Fatal(err)
	}
	out, errout, code, err := Exec(context.Background(), "container-1", []string{"sh", "-lc", "echo ok"}, "/workspace", map[string]string{"A": "B"})
	if err != nil || out != "out" || errout != "err" || code != 7 {
		t.Fatalf("exec=(%q,%q,%d,%v)", out, errout, code, err)
	}
	want := []string{
		"version --format {{.Server.Version}}",
		"version --format {{.Server.Version}}", "stop container-1", "rm -f container-1",
		"version --format {{.Server.Version}}", "exec -w /workspace -e A=B container-1 sh -lc echo ok",
	}
	if strings.Join(fake.calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls=%v want=%v", fake.calls, want)
	}
}

func TestDockerPullAdapterStreamsFragmentedProgressWithoutDocker(t *testing.T) {
	fake := &fakeCommandExecutor{
		combined: func([]string) ([]byte, error) { return []byte("27.1"), nil },
		pull: func(args []string, w io.Writer, progress bool) error {
			if !progress || strings.Join(args, " ") != "pull repo:tag" {
				t.Fatalf("args=%v progress=%v", args, progress)
			}
			_, _ = w.Write([]byte("abc123def456: Downloading 1 KiB /"))
			_, _ = w.Write([]byte(" 2 KiB\r"))
			return nil
		},
	}
	withFakeCommands(t, fake)
	var events []PullEvent
	if err := PullWithProgress(context.Background(), "repo:tag", func(event PullEvent) { events = append(events, event) }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ID != "abc123def456" || events[0].ProgressDetail == nil || events[0].ProgressDetail.Current != 1024 || events[0].ProgressDetail.Total != 2048 {
		t.Fatalf("events=%#v", events)
	}
}
