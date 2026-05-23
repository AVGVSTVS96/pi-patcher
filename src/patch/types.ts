export type Replacement = { oldText: string; newText: string };

export type FileEntry = { target: string; replacements: Replacement[] };

export type PatchSpec = {
  files?: FileEntry[];
  // Legacy single-file shape:
  target?: string;
  replacements?: Replacement[];
};

export type Patch = {
  id: string;
  dir: string;
  tombstoned: boolean;
  intent: string;
  spec: PatchSpec;
};

export type Status = "applied" | "pending" | "drift" | "tombstoned";

/** Normalize the two spec shapes into one. */
export function filesOf(spec: PatchSpec): FileEntry[] {
  if (Array.isArray(spec.files)) return spec.files;
  if (spec.target && Array.isArray(spec.replacements))
    return [{ target: spec.target, replacements: spec.replacements }];
  return [];
}
