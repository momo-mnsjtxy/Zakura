package host

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type sharedPipe struct {
	closes atomic.Int32
	err    error
}

func (*sharedPipe) Read([]byte) (int, error)    { return 0, errors.New("closed") }
func (*sharedPipe) Write(p []byte) (int, error) { return len(p), nil }
func (p *sharedPipe) Close() error              { p.closes.Add(1); return p.err }

func TestLiveStreamConcurrentCloseIsExactlyOnceAndPreservesFirstError(t *testing.T) {
	want := errors.New("close failed")
	pipe := &sharedPipe{err: want}
	var cancels atomic.Int32
	stream := &LiveStream{In: pipe, Out: pipe, Cancel: func() { cancels.Add(1) }}
	results := make([]error, 8)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i] = stream.Close() }(i)
	}
	wg.Wait()
	if pipe.closes.Load() != 1 || cancels.Load() != 1 {
		t.Fatalf("closes=%d cancels=%d", pipe.closes.Load(), cancels.Load())
	}
	for _, err := range results {
		if !errors.Is(err, want) {
			t.Fatalf("error=%v", err)
		}
	}
}

func TestRegistryEvictionIsBoundedAndDoesNotDeleteReplacement(t *testing.T) {
	r := NewRegistry()
	var evict func()
	r.after = func(_ time.Duration, fn func()) { evict = fn }
	job := &Job{ID: "job"}
	replacement := &Job{ID: "job"}
	r.jobs[job.ID] = job
	r.scheduleEviction(job)
	r.jobs[job.ID] = replacement
	evict()
	if r.jobs[job.ID] != replacement {
		t.Fatal("replacement was evicted")
	}
	r.scheduleEviction(replacement)
	evict()
	if r.jobs[job.ID] != nil {
		t.Fatal("terminal job not evicted")
	}
}
