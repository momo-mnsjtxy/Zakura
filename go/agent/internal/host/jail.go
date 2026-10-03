package host

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Jail 把相对工作区路径限制在 root 下（Windows 盘符与斜杠一并处理）。
func Jail(root, rel string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if strings.ContainsRune(rel, '\x00') {
		return "", fmt.Errorf("路径不能包含 NUL")
	}
	cleaned := strings.ReplaceAll(rel, "\\", "/")
	rootSlash := strings.TrimRight(filepath.ToSlash(rootAbs), "/")
	// Strip exactly one known root before resolving parent segments. A child
	// directory named workspace must not be stripped a second time.
	if rootSlash != "" && (cleaned == rootSlash || strings.HasPrefix(cleaned, rootSlash+"/")) {
		cleaned = strings.TrimPrefix(cleaned, rootSlash)
	} else if cleaned == "/workspace" || strings.HasPrefix(cleaned, "/workspace/") {
		cleaned = strings.TrimPrefix(cleaned, "/workspace")
	}
	if cleaned == "" || cleaned == "/" {
		return rootAbs, nil
	}
	cleaned = strings.TrimLeft(cleaned, "/")
	if runtime.GOOS == "windows" {
		if filepath.IsAbs(cleaned) || strings.Contains(cleaned, ":") {
			return "", fmt.Errorf("拒绝绝对路径: %s", rel)
		}
	}
	joined := filepath.Join(rootAbs, filepath.FromSlash(cleaned))
	relToRoot, err := filepath.Rel(rootAbs, joined)
	if err != nil || relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) || filepath.IsAbs(relToRoot) {
		return "", fmt.Errorf("路径越狱: %s", ScrubHostPathsInMessage(rootAbs, rel))
	}
	return joined, nil
}

// WorkspacePath returns the API path for an already resolved path in root.
func WorkspacePath(root, abs string) string {
	rootAbs, _ := filepath.Abs(root)
	rel, _ := filepath.Rel(rootAbs, abs)
	if rel == "." {
		return "/"
	}
	return "/" + filepath.ToSlash(rel)
}

func ScrubHostPathsInMessage(root, message string) string {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return message
	}
	for _, prefix := range []string{rootAbs, filepath.ToSlash(rootAbs)} {
		prefix = strings.TrimRight(prefix, `/\`)
		if prefix != "" {
			message = strings.ReplaceAll(message, prefix, "/workspace")
		}
	}
	return message
}

func SpaceWorkspace(storageRoot, spaceID string) string {
	// spaceID crosses the control-plane/agent trust boundary.  Never let it
	// participate in path resolution: a compromised or buggy control plane must
	// not be able to turn "../../..." into an arbitrary host filesystem root.
	// Valid IDs are deliberately conservative and match the IDs emitted by the
	// server.  Invalid values are mapped to a harmless, non-colliding directory;
	// callers will see normal not-found errors without learning host paths.
	if !safeSpaceID(spaceID) {
		spaceID = "_invalid-space-id_"
	}
	return filepath.Join(storageRoot, "spaces", spaceID, "workspace")
}

func safeSpaceID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func EnsureDir(path string) error {
	return os.MkdirAll(path, 0o755)
}
