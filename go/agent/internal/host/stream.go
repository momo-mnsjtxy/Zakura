package host

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"reflect"
	"sync"
	"time"
)

// LiveStream 统一的交互流（真 PTY / Windows 管道 / docker exec -i）。
type LiveStream struct {
	ID        string
	Mode      string
	In        io.WriteCloser
	Out       io.ReadCloser
	Cmd       *exec.Cmd
	Cancel    func()
	ResizeFn  func(cols, rows int) error
	closeOnce sync.Once
	closeErr  error
}

func (s *LiveStream) Write(b []byte) (int, error) { return s.In.Write(b) }
func (s *LiveStream) Read(b []byte) (int, error)  { return s.Out.Read(b) }
func (s *LiveStream) Resize(cols, rows int) error {
	if s.ResizeFn != nil {
		return s.ResizeFn(cols, rows)
	}
	return nil
}
func (s *LiveStream) Close() error {
	s.closeOnce.Do(func() {
		if s.Cancel != nil {
			s.Cancel()
		}
		var first error
		if s.In != nil {
			first = s.In.Close()
		}
		if s.Out != nil && !sameCloser(s.In, s.Out) {
			if err := s.Out.Close(); first == nil {
				first = err
			}
		}
		if s.Cmd != nil && s.Cmd.Process != nil {
			if err := s.Cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) && first == nil {
				first = err
			}
			waited := make(chan error, 1)
			go func() { waited <- s.Cmd.Wait() }()
			select {
			case <-waited:
			case <-time.After(2 * time.Second):
				if first == nil {
					first = fmt.Errorf("stream process cleanup timed out")
				}
			}
		}
		s.closeErr = first
	})
	return s.closeErr
}

func sameCloser(a io.WriteCloser, b io.ReadCloser) bool {
	if a == nil || b == nil {
		return false
	}
	av, bv := reflect.ValueOf(a), reflect.ValueOf(b)
	return av.Kind() == reflect.Pointer && bv.Kind() == reflect.Pointer && av.Pointer() == bv.Pointer()
}

func newPipeSession(id string, stdin io.WriteCloser, stdout io.ReadCloser, cmd *exec.Cmd, cancel func()) *LiveStream {
	return &LiveStream{ID: id, Mode: "pipe", In: stdin, Out: stdout, Cmd: cmd, Cancel: cancel}
}
