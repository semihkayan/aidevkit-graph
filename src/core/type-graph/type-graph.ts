import type {
  ITypeGraphReader, ITypeGraphWriter, IFunctionIndexReader, ILanguageParser,
} from "../../types/interfaces.js";
import type { TypeRelationGraph, TypeNode } from "../../types/index.js";
import { readFile } from "../../utils/file-utils.js";
import { computeIndexFingerprint, saveGraphJson, loadGraphJson } from "../../utils/graph-persistence.js";
import path from "node:path";

export class TypeGraphManager implements ITypeGraphReader, ITypeGraphWriter {
  private graph: TypeRelationGraph = new Map();

  async build(
    index: IFunctionIndexReader,
    parsers: ILanguageParser[],
    projectRoot: string,
  ): Promise<TypeRelationGraph> {
    this.graph.clear();

    for (const filePath of index.getAllFilePaths()) {
      const parser = parsers.find(p => p.canParse(filePath));
      if (!parser) continue;

      const absPath = path.join(projectRoot, filePath);
      let source: string;
      try {
        source = await readFile(absPath);
      } catch { continue; }

      const typeRels = parser.parseTypeRelationships(source, filePath);

      for (const rel of typeRels) {
        // Class/struct node
        this.ensureNode(rel.className, rel.kind, filePath, rel.lineStart, rel.lineEnd);
        const classId = `${filePath}::${rel.className}`;

        // implements
        for (const iface of rel.implements) {
          const node = this.ensureNode(iface, "interface", "", 0, 0);
          if (!node.implementors.includes(classId)) node.implementors.push(classId);
        }

        // extends
        for (const base of rel.extends) {
          const node = this.ensureNode(base, "class", "", 0, 0);
          if (!node.extenders.includes(classId)) node.extenders.push(classId);
        }

        // usesTypes
        for (const typeName of rel.usesTypes) {
          const node = this.ensureNode(typeName, "type_alias", "", 0, 0);
          if (!node.usedBy.includes(classId)) node.usedBy.push(classId);
        }

        // members (interface properties, constructor field types)
        if (rel.members) {
          const node = this.graph.get(rel.className);
          if (node) {
            for (const m of rel.members) {
              node.members[m.name] = m.type;
            }
          }
        }
      }

      // Also track function-level type usages from typeRelationships on records
      for (const rec of index.getByFile(filePath)) {
        if (rec.typeRelationships) {
          for (const typeName of rec.typeRelationships.usesTypes) {
            const node = this.ensureNode(typeName, "type_alias", "", 0, 0);
            if (!node.usedBy.includes(rec.id)) node.usedBy.push(rec.id);
          }
        }
      }
    }

    return this.graph;
  }

  async buildForFiles(
    files: string[],
    index: IFunctionIndexReader,
    parsers: ILanguageParser[],
    projectRoot: string,
  ): Promise<void> {
    // Remove old relationships for these files before adding new ones
    for (const filePath of files) {
      this.removeByFile(filePath);
    }

    for (const filePath of files) {
      const parser = parsers.find(p => p.canParse(filePath));
      if (!parser) continue;

      const absPath = path.join(projectRoot, filePath);
      let source: string;
      try {
        source = await readFile(absPath);
      } catch { continue; }

      const typeRels = parser.parseTypeRelationships(source, filePath);

      for (const rel of typeRels) {
        this.ensureNode(rel.className, rel.kind, filePath, rel.lineStart, rel.lineEnd);
        const classId = `${filePath}::${rel.className}`;

        for (const iface of rel.implements) {
          const node = this.ensureNode(iface, "interface", "", 0, 0);
          if (!node.implementors.includes(classId)) node.implementors.push(classId);
        }
        for (const base of rel.extends) {
          const node = this.ensureNode(base, "class", "", 0, 0);
          if (!node.extenders.includes(classId)) node.extenders.push(classId);
        }
        for (const typeName of rel.usesTypes) {
          const node = this.ensureNode(typeName, "type_alias", "", 0, 0);
          if (!node.usedBy.includes(classId)) node.usedBy.push(classId);
        }

        if (rel.members) {
          const node = this.graph.get(rel.className);
          if (node) {
            for (const m of rel.members) {
              node.members[m.name] = m.type;
            }
          }
        }
      }

      for (const rec of index.getByFile(filePath)) {
        if (rec.typeRelationships) {
          for (const typeName of rec.typeRelationships.usesTypes) {
            const node = this.ensureNode(typeName, "type_alias", "", 0, 0);
            if (!node.usedBy.includes(rec.id)) node.usedBy.push(rec.id);
          }
        }
      }
    }
  }

  removeByFile(filePath: string): void {
    const filePrefix = `${filePath}::`;
    for (const [name, node] of this.graph) {
      if (node.filePath === filePath) {
        // Don't delete the node — other files may reference it.
        // Clear file-owned data but preserve cross-file references.
        node.filePath = "";
        node.lineStart = 0;
        node.lineEnd = 0;
        node.members = {};
      }
      // Remove references FROM this file (both own nodes and references to this file's classes)
      node.implementors = node.implementors.filter(id => !id.startsWith(filePrefix));
      node.extenders = node.extenders.filter(id => !id.startsWith(filePrefix));
      node.usedBy = node.usedBy.filter(id => !id.startsWith(filePrefix));
    }

    // Clean up empty shell nodes (no file, no references) to avoid unbounded growth
    for (const [name, node] of this.graph) {
      if (!node.filePath && node.implementors.length === 0 && node.extenders.length === 0 && node.usedBy.length === 0) {
        this.graph.delete(name);
      }
    }
  }

  // === ITypeGraphReader ===

  getTypeNode(typeName: string): TypeNode | undefined {
    return this.graph.get(typeName);
  }

  getImplementors(typeName: string): string[] {
    return this.graph.get(typeName)?.implementors || [];
  }

  getExtenders(typeName: string): string[] {
    return this.graph.get(typeName)?.extenders || [];
  }

  getUsages(typeName: string): string[] {
    return this.graph.get(typeName)?.usedBy || [];
  }

  getMemberType(typeName: string, memberName: string): string | undefined {
    return this.graph.get(typeName)?.members[memberName];
  }

  getTypeChain(typeName: string): string[] {
    // Downward: typeName → extenders (recursive BFS)
    const chain: string[] = [typeName];
    const visited = new Set<string>([typeName]);
    const queue = [typeName];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.graph.get(current);
      if (!node) continue;

      for (const extenderId of node.extenders) {
        const name = extenderId.split("::").pop()!;
        if (!visited.has(name)) {
          visited.add(name);
          chain.push(name);
          queue.push(name);
        }
      }
    }

    return chain;
  }

  getAllTypes(): string[] {
    return Array.from(this.graph.keys());
  }

  getStats(): { types: number; relationships: number } {
    let relationships = 0;
    for (const node of this.graph.values()) {
      relationships += node.implementors.length + node.extenders.length + node.usedBy.length;
    }
    return { types: this.graph.size, relationships };
  }

  async saveToDisk(cacheDir: string, index: IFunctionIndexReader): Promise<void> {
    const fp = computeIndexFingerprint(index);
    await saveGraphJson(path.join(cacheDir, "type-graph.json"), fp, this.graph);
  }

  async loadFromDisk(cacheDir: string, index: IFunctionIndexReader): Promise<boolean> {
    const fp = computeIndexFingerprint(index);
    const loaded = await loadGraphJson(path.join(cacheDir, "type-graph.json"), fp);
    if (!loaded) return false;
    this.graph = loaded as TypeRelationGraph;
    return true;
  }

  // === Private ===

  private ensureNode(
    name: string, kind: TypeNode["kind"],
    filePath: string, lineStart: number, lineEnd: number,
  ): TypeNode {
    let node = this.graph.get(name);
    if (!node) {
      node = { name, kind, filePath, lineStart, lineEnd, implementors: [], extenders: [], usedBy: [], members: {} };
      this.graph.set(name, node);
    }
    if (filePath && !node.filePath) {
      node.filePath = filePath;
      node.lineStart = lineStart;
      node.lineEnd = lineEnd;
      node.kind = kind;
    }
    return node;
  }

  clear(): void {
    this.graph.clear();
  }
}
