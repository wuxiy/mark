export interface LineChanges {
  before: string[];
  after: string[];
  beforeChanged: boolean[];
  afterChanged: boolean[];
  coarse: boolean;
}

export function lineChanges(oldText: string, newText: string): LineChanges {
  const before = oldText ? oldText.split('\n') : [];
  const after = newText ? newText.split('\n') : [];
  const beforeChanged = before.map(() => false);
  const afterChanged = after.map(() => false);
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;

  const oldCount = before.length - prefix - suffix;
  const newCount = after.length - prefix - suffix;
  const cells = (oldCount + 1) * (newCount + 1);
  if (cells > 2_000_000) {
    beforeChanged.fill(true, prefix, before.length - suffix);
    afterChanged.fill(true, prefix, after.length - suffix);
    return { before, after, beforeChanged, afterChanged, coarse: true };
  }

  const width = newCount + 1;
  const lengths = new Uint32Array(cells);
  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex--) {
      const cell = oldIndex * width + newIndex;
      lengths[cell] = before[prefix + oldIndex] === after[prefix + newIndex]
        ? lengths[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(lengths[(oldIndex + 1) * width + newIndex], lengths[cell + 1]);
    }
  }
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldCount || newIndex < newCount) {
    if (oldIndex < oldCount && newIndex < newCount && before[prefix + oldIndex] === after[prefix + newIndex]) {
      oldIndex++;
      newIndex++;
    } else if (oldIndex < oldCount && (newIndex === newCount || lengths[(oldIndex + 1) * width + newIndex] >= lengths[oldIndex * width + newIndex + 1])) {
      beforeChanged[prefix + oldIndex++] = true;
    } else {
      afterChanged[prefix + newIndex++] = true;
    }
  }
  return { before, after, beforeChanged, afterChanged, coarse: false };
}
