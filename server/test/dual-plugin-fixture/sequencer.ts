import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";

class DatabaseFirst extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return files.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: { sequence: { sequencer: DatabaseFirst } },
});
