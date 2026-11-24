export type ImportRow = {
  id: string;
  sourceKey: string;
  sourceIndex: number;
  status: "supported" | "invalid" | "unsupported";
  title: string;
  body?: string;
  reason: string;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const badText = (v: string) => /[\u0000\uD800-\uDFFF]/u.test(v);
/** Pure local decoding: never sends an archive, deletes storage or guesses ownership. */
export function previewArchive(
  raw: string,
  account: string,
): { accountId: string; rows: ImportRow[] } {
  if (new TextEncoder().encode(raw).byteLength > 5 * 1024 * 1024)
    throw new Error("原始导出最多5 MiB，请保留原文件并分批整理。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON 已损坏，未上传任何记录。请保留原文件。");
  }
  if (
    !record(value) ||
    value.format !== "studyc-local-data-export" ||
    value.version !== 1 ||
    typeof value.accountId !== "string" ||
    value.accountId.toLowerCase() !== account.toLowerCase() ||
    !record(value.entries) ||
    (value.rawEntries !== undefined && !record(value.rawEntries))
  )
    throw new Error(
      "需要当前账户导出的 StudyC v1 JSON；不会按姓名推测归属或导入其他账户。",
    );
  const entries = value.entries,
    rawEntries = (value.rawEntries ?? {}) as Record<string, unknown>,
    keys = [
      ...new Set([...Object.keys(entries), ...Object.keys(rawEntries)]),
    ].sort();
  if (keys.length > 1000)
    throw new Error("导出包含超过1000个记录键，请保留原文件并分批整理。");
  const rows: ImportRow[] = [];
  for (const key of keys) {
    let data = entries[key];
    let issue = "";
    if (Object.hasOwn(rawEntries, key)) {
      try {
        if (typeof rawEntries[key] !== "string") throw new Error();
        data = JSON.parse(rawEntries[key] as string);
        if (
          Object.hasOwn(entries, key) &&
          JSON.stringify(data) !== JSON.stringify(entries[key])
        )
          issue = "原始记录与解析副本不一致，请保留备份后检查。";
      } catch {
        issue = "原始记录不是有效 JSON。";
      }
    }
    const row = (
      status: ImportRow["status"],
      reason: string,
      index = -1,
      title = key,
      body?: string,
    ) =>
      rows.push({
        id: key + ":" + index,
        sourceKey: key,
        sourceIndex: index,
        status,
        title,
        body,
        reason,
      });
    if (issue) {
      row("invalid", issue);
      continue;
    }
    if (key !== "sf-k12:uploads") {
      row(
        "unsupported",
        "此版本仅导入旧版上传资料中的纯文本；此项保留在原始备份。",
      );
      continue;
    }
    if (!Array.isArray(data)) {
      row("invalid", "上传资料应为列表。");
      continue;
    }
    if (data.length > 1000)
      throw new Error("上传资料超过1000项，请保留原文件并分批整理。");
    if (!data.length) {
      row("unsupported", "上传资料列表为空。");
      continue;
    }
    data.forEach((item, index) => {
      if (
        !record(item) ||
        Object.keys(item).some((k) => !["title", "text"].includes(k)) ||
        typeof item.title !== "string" ||
        typeof item.text !== "string"
      ) {
        row(
          "invalid",
          "需要完整 title/text 纯文本字段；不会猜测其他格式。",
          index,
        );
        return;
      }
      const title = item.title.trim();
      if (
        !title ||
        Array.from(title).length > 120 ||
        badText(title) ||
        badText(item.text) ||
        new TextEncoder().encode(item.text).byteLength > 1048576
      ) {
        row(
          "invalid",
          "标题应为1–120个字符，正文最多1 MiB，且不能含无效字符。",
          index,
          title || "无标题",
        );
        return;
      }
      row(
        "supported",
        "可作为一份新的纯文本资料导入。",
        index,
        title,
        item.text,
      );
    });
  }
  return { accountId: account.toLowerCase(), rows };
}
