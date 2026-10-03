package host

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type failingAtomicOps struct {
	osAtomicFileOps
	failRename bool
	removes    []string
}

func (f *failingAtomicOps) Rename(from, to string) error {
	if f.failRename {
		return errors.New("rename failed")
	}
	return f.osAtomicFileOps.Rename(from, to)
}
func (f *failingAtomicOps) Remove(path string) error {
	f.removes = append(f.removes, path)
	return f.osAtomicFileOps.Remove(path)
}

func TestAtomicWriteFailurePreservesDestinationCleansAndRetries(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "state.txt")
	if err := os.WriteFile(path, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := &failingAtomicOps{failRename: true}
	previous := hostFileOps
	hostFileOps = fake
	t.Cleanup(func() { hostFileOps = previous })
	if err := atomicWriteFile(path, []byte("broken"), 0o644); err == nil {
		t.Fatal("expected failure")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "before" {
		t.Fatalf("data=%q", data)
	}
	if len(fake.removes) != 1 {
		t.Fatalf("cleanup calls=%v", fake.removes)
	}
	if _, err := os.Stat(fake.removes[0]); !os.IsNotExist(err) {
		t.Fatalf("temp remained: %v", err)
	}
	fake.failRename = false
	if err := atomicWriteFile(path, []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != "after" {
		t.Fatalf("data=%q", data)
	}
}
