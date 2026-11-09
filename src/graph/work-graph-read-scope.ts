import { WorkGraphError, type BlockingRef, type NodeRef, type NodeState } from "./work-graph";
import { validateRepoRef, type RepoRef } from "./work-graph-ref";

export interface GraphReadScope {
  repositories: readonly RepoRef[];
  namespaces?: readonly RepoRef[];
}

export function validateGraphReadScope(scope: GraphReadScope): GraphReadScope {
  const repositories = scope.repositories.map(validateRepoRef);
  const namespaces = (scope.namespaces ?? []).map(validateRepoRef);
  if (namespaces.some((repo) => repo.forge !== "gitlab")) throw new WorkGraphError("invalid-node", "Read namespaces require GitLab refs");
  return { repositories, namespaces };
}

export function permitsGraphRead(scope: GraphReadScope | undefined, repo: RepoRef): boolean {
  if (scope === undefined) return true;
  const sameAuthority = (entry: RepoRef): boolean => entry.forge === repo.forge && entry.host === repo.host;
  const path = repo.path.toLowerCase();
  return scope.repositories.some((entry) => sameAuthority(entry) && entry.path.toLowerCase() === path) ||
    (scope.namespaces ?? []).some((entry) => {
      const namespace = entry.path.toLowerCase();
      return sameAuthority(entry) && (path === namespace || path.startsWith(`${namespace}/`));
    });
}

export function assertGraphRead(scope: GraphReadScope | undefined, repo: RepoRef): void {
  if (!permitsGraphRead(scope, repo)) throw new WorkGraphError("invalid-node", "Graph read unavailable in the permitted scope");
}

export function scopeNodeState(state: NodeState, allowed: (ref: NodeRef) => boolean): NodeState {
  const blockedBy = state.blockedBy.map((ref): BlockingRef => allowed(ref) ? ref : { id: ref.id, status: "unavailable" });
  const parent = state.parent === undefined || allowed(state.parent) ? state.parent : { id: state.parent.id, unavailable: true as const };
  return { ...state, blockedBy, ...(parent === undefined ? {} : { parent }) };
}
