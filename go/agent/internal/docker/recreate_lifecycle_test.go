package docker

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

type fakeRecreateOps struct {
	current     string
	raw         string
	containers  []ContainerInfo
	specValue   RunSpec
	runResult   ContainerInfo
	runErr      error
	calls       []string
	removeErrAt map[int]error
	removeCount int
	onRename    func()
}

func (f *fakeRecreateOps) currentImage(context.Context, string) (string, error) {
	return f.current, nil
}
func (f *fakeRecreateOps) list(context.Context) ([]ContainerInfo, error)          { return f.containers, nil }
func (f *fakeRecreateOps) containerImage(context.Context, string) (string, error) { return f.raw, nil }
func (f *fakeRecreateOps) spec(context.Context, string) (RunSpec, error)          { return f.specValue, nil }
func (f *fakeRecreateOps) removeName(_ context.Context, name string) error {
	f.removeCount++
	f.calls = append(f.calls, "rm "+name)
	return f.removeErrAt[f.removeCount]
}
func (f *fakeRecreateOps) rename(_ context.Context, from, to string) error {
	f.calls = append(f.calls, "rename "+from+" "+to)
	if f.onRename != nil {
		cb := f.onRename
		f.onRename = nil
		cb()
	}
	return nil
}
func (f *fakeRecreateOps) run(_ context.Context, spec RunSpec) (ContainerInfo, error) {
	f.calls = append(f.calls, "run "+spec.Name)
	return f.runResult, f.runErr
}

func staleOps() *fakeRecreateOps {
	return &fakeRecreateOps{
		current: "new-id", raw: "old-id",
		containers:  []ContainerInfo{{DockerID: "c1", Name: "workspace", Image: "repo:tag", Labels: map[string]string{"zakura.space": "s"}}},
		specValue:   RunSpec{Name: "workspace", Image: "old"},
		runResult:   ContainerInfo{DockerID: "new", Name: "workspace", Image: "repo:tag"},
		removeErrAt: map[int]error{},
	}
}

func TestRecreateTransactionCommitsAndCleansBackup(t *testing.T) {
	fake := staleOps()
	result, err := recreateStale(context.Background(), "repo:tag", fake)
	if err != nil || len(result.Recreated) != 1 || len(result.Failed) != 0 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	want := []string{"rm workspace.bak", "rename workspace workspace.bak", "run workspace", "rm workspace.bak"}
	if fmt.Sprint(fake.calls) != fmt.Sprint(want) {
		t.Fatalf("calls=%v want=%v", fake.calls, want)
	}
}

func TestRecreateFailureRemovesPartialAndRollsBackExactlyOnce(t *testing.T) {
	fake := staleOps()
	fake.runErr = errors.New("create failed")
	result, err := recreateStale(context.Background(), "repo:tag", fake)
	if err != nil || len(result.Recreated) != 0 || len(result.Failed) != 1 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	want := []string{"rm workspace.bak", "rename workspace workspace.bak", "run workspace", "rm workspace", "rename workspace.bak workspace"}
	if fmt.Sprint(fake.calls) != fmt.Sprint(want) {
		t.Fatalf("calls=%v want=%v", fake.calls, want)
	}
}

func TestRecreateCancellationAfterRenameRollsBack(t *testing.T) {
	fake := staleOps()
	ctx, cancel := context.WithCancel(context.Background())
	fake.onRename = cancel
	result, err := recreateStale(ctx, "repo:tag", fake)
	if err != nil || len(result.Failed) != 1 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	want := []string{"rm workspace.bak", "rename workspace workspace.bak", "rm workspace", "rename workspace.bak workspace"}
	if fmt.Sprint(fake.calls) != fmt.Sprint(want) {
		t.Fatalf("calls=%v want=%v", fake.calls, want)
	}
}

func TestRecreateCleanupFailureIsVisibleAndRetryable(t *testing.T) {
	fake := staleOps()
	fake.removeErrAt[2] = errors.New("cleanup interrupted")
	first, err := recreateStale(context.Background(), "repo:tag", fake)
	if err != nil || len(first.Recreated) != 1 || len(first.Failed) != 1 {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	fake.removeErrAt = map[int]error{}
	fake.raw = "new-id"
	fake.calls = nil
	second, err := recreateStale(context.Background(), "repo:tag", fake)
	if err != nil || second.Skipped != 1 || len(second.Failed) != 0 {
		t.Fatalf("second=%#v err=%v", second, err)
	}
	if fmt.Sprint(fake.calls) != fmt.Sprint([]string{"rm workspace.bak"}) {
		t.Fatalf("retry calls=%v", fake.calls)
	}
}
