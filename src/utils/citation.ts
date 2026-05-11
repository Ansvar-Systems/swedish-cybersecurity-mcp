/**
 * Citation utilities for cyber-cohort MCPs.
 *
 * v2 — options-object signatures with mandatory attribution triple per
 * docs/superpowers/specs/2026-05-02-source-attribution-airtight-design.md.
 *
 * The attribution triple (source_url, publisher, license) is load-bearing.
 * Every CitationMetadata produced by this module has all three populated.
 *
 * Replaces v1 positional signatures. The breaking signature change is
 * deliberate — `tsc --noEmit` fails any caller that has not migrated.
 *
 * Note on naming: this file's `CitationMetadata` is structurally distinct from
 * the `CitationMetadata` interface in `infrastructure/law-mcp-templates/`. The
 * law-cohort version omits attribution fields and predates the Source
 * Attribution Airtight standard. The two templates target different cohorts —
 * this file is copied into cyber-cohort MCPs; the law-cohort template stays
 * with law MCPs. They never coexist inside a single deployed repo.
 */

export interface AttributionTriple {
  source_url: string;
  publisher: string;
  license: string;
  attribution_text?: string;
}

// `toolArgs` values must be pre-stringified by the caller. Numeric/boolean values must be wrapped with `String(...)` before being passed in. This narrowness matches the existing law-cohort templates and the gateway's lookup-arg shape.
export interface CitationOptions {
  canonicalRef: string;
  displayText: string;
  toolName: string;
  toolArgs: Record<string, string>;
  attribution: AttributionTriple;
  aliases?: string[];
}

export interface CitationMetadata {
  canonical_ref: string;
  display_text: string;
  aliases?: string[];
  lookup: { tool: string; args: Record<string, string> };
  source_url: string;
  publisher: string;
  license: string;
  attribution_text?: string;
}

export function buildCitation(opts: CitationOptions): CitationMetadata {
  if (!opts.attribution.source_url) {
    throw new Error("buildCitation: attribution.source_url is required and must be non-empty");
  }
  if (!opts.attribution.publisher) {
    throw new Error("buildCitation: attribution.publisher is required and must be non-empty");
  }
  if (!opts.attribution.license) {
    throw new Error("buildCitation: attribution.license is required and must be non-empty");
  }
  const meta: CitationMetadata = {
    canonical_ref: opts.canonicalRef,
    display_text: opts.displayText,
    lookup: { tool: opts.toolName, args: opts.toolArgs },
    source_url: opts.attribution.source_url,
    publisher: opts.attribution.publisher,
    license: opts.attribution.license,
  };
  if (opts.aliases && opts.aliases.length > 0) {
    meta.aliases = opts.aliases;
  }
  if (opts.attribution.attribution_text) {
    meta.attribution_text = opts.attribution.attribution_text;
  }
  return meta;
}

export interface ProvisionCitationOptions {
  documentId: string;
  documentTitle: string;
  provisionRef: string;
  inputDocId: string;
  inputSection: string;
  attribution: AttributionTriple;
  shortName?: string | null;
}

export function buildProvisionCitation(opts: ProvisionCitationOptions): CitationMetadata {
  // attribution is validated inside buildCitation when this function delegates at the bottom; no need to validate here.
  // SFS (Swedish) and LOV- (Norwegian) prefix detection are law-cohort-specific. Cyber-cohort callers fall through to the default branch (canonicalRef = documentTitle || documentId). buildProvisionCitation is included in this template for parity with the law-cohort utility, but the cyber cohort primarily calls buildCitation and buildRegulationCitation directly.
  let canonicalRef: string;
  if (opts.documentId.match(/^\d{4}:\d+$/)) {
    canonicalRef = `SFS ${opts.documentId}`;
  } else if (opts.documentId.match(/^LOV-\d{4}/)) {
    canonicalRef = opts.documentId;
  } else {
    canonicalRef = opts.documentTitle || opts.documentId;
  }

  let displayText: string;
  if (opts.provisionRef && opts.provisionRef.includes(":")) {
    const [ch, sec] = opts.provisionRef.split(":");
    displayText = `${ch} kap. ${sec} § ${canonicalRef}`;
  } else if (opts.provisionRef) {
    displayText = `§ ${opts.provisionRef} ${canonicalRef}`;
  } else {
    displayText = canonicalRef;
  }

  const aliases: string[] = [];
  if (opts.shortName) aliases.push(opts.shortName);
  if (opts.documentId !== canonicalRef) aliases.push(opts.documentId);
  if (opts.documentTitle && opts.documentTitle !== canonicalRef) aliases.push(opts.documentTitle);

  return buildCitation({
    canonicalRef,
    displayText,
    toolName: "get_provision",
    toolArgs: { document_id: opts.inputDocId, section: opts.inputSection },
    attribution: opts.attribution,
    ...(aliases.length > 0 && { aliases }),
  });
}

export interface RegulationCitationOptions {
  reference: string;
  title: string;
  toolName: string;
  toolArgs: Record<string, string>;
  attribution: AttributionTriple;
  authority?: string | null;
}

export function buildRegulationCitation(opts: RegulationCitationOptions): CitationMetadata {
  const aliases: string[] = [];
  if (opts.authority) aliases.push(`${opts.authority}: ${opts.reference}`);

  return buildCitation({
    canonicalRef: opts.reference,
    displayText: opts.title || opts.reference,
    toolName: opts.toolName,
    toolArgs: opts.toolArgs,
    attribution: opts.attribution,
    ...(aliases.length > 0 && { aliases }),
  });
}
