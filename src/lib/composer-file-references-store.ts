export interface ComposerFileReference {
  ref: string;
  label?: string;
  kind?: "file" | "folder";
  order?: number;
  status?: "uploading";
  resourceType?: "repo" | "doc" | "api" | "file" | "image" | "spreadsheet" | "website";
  source?: "upload" | "resource-library" | "bitbucket";
}

type Listener = () => void;

let references: ComposerFileReference[] = [];
const listeners = new Set<Listener>();
const itemOrders = new Map<string, number>();
let nextItemOrder = 1;

function normalizeReference(value: string): string {
  return value.trim().replace(/^@+/, "");
}

function itemOrderKey(type: "attachment" | "reference", value: string): string {
  return `${type}:${value}`;
}

function ensureItemOrder(key: string): number {
  const existing = itemOrders.get(key);
  if (existing !== undefined) return existing;
  const order = nextItemOrder;
  nextItemOrder += 1;
  itemOrders.set(key, order);
  return order;
}

function emit() {
  for (const listener of listeners) listener();
}

export const composerFileReferencesStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(): readonly ComposerFileReference[] {
    return references;
  },
  add(input: string | ComposerFileReference): void {
    const ref = normalizeReference(typeof input === "string" ? input : input.ref);
    if (!ref) return;
    const label = typeof input === "string" ? undefined : input.label?.trim() || undefined;
    const kind = typeof input === "string" ? undefined : input.kind;
    const status = typeof input === "string" ? undefined : input.status;
    const resourceType = typeof input === "string" ? undefined : input.resourceType;
    const source = typeof input === "string" ? undefined : input.source;
    const index = references.findIndex((item) => item.ref === ref);
    if (index >= 0) {
      const existing = references[index];
      const nextLabel = label ?? existing?.label;
      const nextKind = kind ?? existing?.kind;
      const nextResourceType = resourceType ?? existing?.resourceType;
      const nextSource = source ?? existing?.source;
      if (existing?.label === nextLabel && existing?.kind === nextKind && existing?.status === status && existing?.resourceType === nextResourceType && existing?.source === nextSource) return;
      const nextReference = { ref, ...(nextLabel ? { label: nextLabel } : {}), ...(nextKind ? { kind: nextKind } : {}), ...(status ? { status } : {}), ...(nextResourceType ? { resourceType: nextResourceType } : {}), ...(nextSource ? { source: nextSource } : {}), order: existing?.order ?? ensureItemOrder(itemOrderKey("reference", ref)) };
      references = references.map((item, itemIndex) => itemIndex === index ? nextReference : item);
      emit();
      return;
    }
    const nextReference = { ref, ...(label ? { label } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(resourceType ? { resourceType } : {}), ...(source ? { source } : {}), order: ensureItemOrder(itemOrderKey("reference", ref)) };
    references = [...references, nextReference];
    emit();
  },
  replace(currentRef: string, input: string | ComposerFileReference): void {
    const normalizedCurrent = normalizeReference(currentRef);
    const nextRef = normalizeReference(typeof input === "string" ? input : input.ref);
    if (!normalizedCurrent || !nextRef) return;
    const index = references.findIndex((item) => item.ref === normalizedCurrent);
    if (index < 0) {
      this.add(input);
      return;
    }
    const label = typeof input === "string" ? undefined : input.label?.trim() || undefined;
    const kind = typeof input === "string" ? undefined : input.kind;
    const status = typeof input === "string" ? undefined : input.status;
    const resourceType = typeof input === "string" ? undefined : input.resourceType;
    const source = typeof input === "string" ? undefined : input.source;
    const order = references[index]?.order ?? ensureItemOrder(itemOrderKey("reference", normalizedCurrent));
    itemOrders.delete(itemOrderKey("reference", normalizedCurrent));
    itemOrders.set(itemOrderKey("reference", nextRef), order);
    references = references.map((item, itemIndex) => itemIndex === index ? { ref: nextRef, ...(label ? { label } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(resourceType ? { resourceType } : {}), ...(source ? { source } : {}), order } : item);
    emit();
  },
  remove(ref: string): void {
    const normalized = normalizeReference(ref);
    const nextReferences = references.filter((item) => item.ref !== normalized);
    if (nextReferences.length === references.length) return;
    references = nextReferences;
    itemOrders.delete(itemOrderKey("reference", normalized));
    emit();
  },
  clear(): void {
    if (!references.length) return;
    for (const reference of references) itemOrders.delete(itemOrderKey("reference", reference.ref));
    references = [];
    emit();
  },
};

export const composerItemOrderStore = {
  ensureAttachment(id: string): number {
    return ensureItemOrder(itemOrderKey("attachment", id));
  },
  clearAll(): void {
    references = [];
    itemOrders.clear();
    nextItemOrder = 1;
    emit();
  },
};
