/** Normalize project form state at the domain boundary. */
export function buildProjectCreateInput({ name, description, gitUrl, withWorkspace }) {
  const normalizedName = name.trim();
  if (!normalizedName) return { error: "请填写项目名" };
  const normalizedGit = gitUrl.trim();
  return {
    value: {
      name: normalizedName,
      description: description.trim() || undefined,
      withWorkspace: Boolean(withWorkspace || normalizedGit),
      ...(normalizedGit ? { gitUrl: normalizedGit } : {}),
    },
  };
}

/** Apply all local consequences of deleting a project as one atomic transition. */
export function removeProjectFromChatState(state, slug) {
  return {
    projects: state.projects.filter((project) => project.slug !== slug),
    sessions: state.sessions.map((session) =>
      session.project === slug ? { ...session, project: null } : session,
    ),
    activeProject: state.activeProject === slug ? null : state.activeProject,
    settingsProject: state.settingsProject === slug ? null : state.settingsProject,
    mainPane: state.settingsProject === slug ? "projects" : state.mainPane,
  };
}
