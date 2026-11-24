import { AuthApiError, type RequestOptions } from "../../auth/api.ts";
export type Folder = {
  id: string;
  title: string;
  version: number;
  setCount: number;
};
export type Assignment = {
  studySetId: string;
  folderId: string | null;
  folderTitle: string | null;
  version: number;
};
export type FolderSet = {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  folderId: string | null;
  assignmentVersion: number;
};
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const fail = (): never => {
  throw new AuthApiError(
    "invalid_response",
    "文件夹记录暂时无法读取，请重试。",
  );
};
export function parseFolder(v: any): Folder {
  if (
    !v ||
    !id(v.id) ||
    typeof v.title !== "string" ||
    !Number.isInteger(v.version) ||
    v.version < 1 ||
    !Number.isInteger(v.setCount) ||
    v.setCount < 0
  )
    fail();
  return v;
}
export function parseAssignment(v: any, set: string): Assignment {
  if (
    !v ||
    v.studySetId !== set ||
    !Number.isInteger(v.version) ||
    v.version < 0 ||
    !(
      (v.folderId === null && v.folderTitle === null) ||
      (id(v.folderId) && typeof v.folderTitle === "string")
    )
  )
    fail();
  return v;
}
export function createFolderApi(
  request: <T>(path: string, options?: RequestOptions) => Promise<T>,
) {
  const root = "/v1/study/folders";
  const page = <T>(v: any, parse: (v: any) => T) => {
    if (
      !v ||
      !Array.isArray(v.items) ||
      !(v.nextCursor === null || id(v.nextCursor))
    )
      fail();
    return {
      items: v.items.map(parse) as T[],
      nextCursor: v.nextCursor as string | null,
    };
  };
  return {
    list: async (cursor?: string) => {
      const v = await request<any>(root + (cursor ? "?cursor=" + cursor : ""));
      if (typeof v.enabled !== "boolean") fail();
      return { ...page(v, parseFolder), enabled: v.enabled as boolean };
    },
    get: async (folder: string) => {
      const v = await request<{ folder: Folder }>(root + "/" + folder);
      if (v.folder?.id !== folder) fail();
      return parseFolder(v.folder);
    },
    save: async (folder: string | undefined, body: unknown) => {
      const v = await request<{ folder: Folder }>(
        root + (folder ? "/" + folder : ""),
        { method: folder ? "PATCH" : "POST", body },
      );
      if (folder && v.folder?.id !== folder) fail();
      return parseFolder(v.folder);
    },
    remove: async (folder: string, body: unknown) => {
      const v = await request<{
        removed: boolean;
        id: string;
        movedSets: number;
      }>(root + "/" + folder + "/remove", { method: "POST", body });
      if (
        v.id !== folder ||
        v.removed !== true ||
        !Number.isInteger(v.movedSets) ||
        v.movedSets < 0
      )
        fail();
      return v;
    },
    sets: async (folder: string, cursor?: string) =>
      page(
        await request(
          root + "/" + folder + "/sets" + (cursor ? "?cursor=" + cursor : ""),
        ),
        (v) => {
          if (
            !v ||
            !id(v.id) ||
            typeof v.title !== "string" ||
            !Number.isInteger(v.version) ||
            v.version < 1 ||
            !Number.isInteger(v.assignmentVersion) ||
            v.assignmentVersion < 0 ||
            !Number.isFinite(Date.parse(v.createdAt)) ||
            !Number.isFinite(Date.parse(v.updatedAt)) ||
            v.folderId !== (folder === "unfiled" ? null : folder)
          )
            fail();
          return v as FolderSet;
        },
      ),
    assignment: async (set: string) => {
      const v = await request<{ assignment: Assignment }>(
        `/v1/study/sets/${set}/folder`,
      );
      return parseAssignment(v.assignment, set);
    },
    move: async (set: string, body: unknown) => {
      const v = await request<{ assignment: Assignment }>(
        `/v1/study/sets/${set}/folder`,
        { method: "PATCH", body },
      );
      return parseAssignment(v.assignment, set);
    },
  };
}
