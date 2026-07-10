#!/usr/bin/env python3
"""
Score the engine's diarization + segmentation against a hand-labeled ground truth.

Ground-truth file: one segment per line, "text | Speaker". A line with no "|" is
treated as the default speaker (--default-speaker, default "Matt").

Method: the ground-truth text is (re-segmented) engine text, so the two word
streams are ~identical. We word-align them (difflib), then:
  * map each engine diarization cluster (SPEAKER_xx) to the true speaker it most
    overlaps (many-to-one majority) and report word-level attribution accuracy
    = cluster purity. This credits over-clustering as long as clusters are pure.
  * also report a strict one-to-one optimal mapping (Hungarian) that penalizes
    over-clustering, so you see both ceilings.
  * segmentation boundary precision/recall/F1 vs your re-segmentation.

Usage:
  python score_transcript.py "2016-11-16 MSSPOT Ep. 1 - Inaugral Business"
  python score_transcript.py <stem> --json-dir gen-large-v3 --gt-dir eval/ground-truth
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
UNKNOWN = "UNKNOWN"
_norm_re = re.compile(r"[^a-z0-9]+")


def norm(token: str) -> str:
    return _norm_re.sub("", token.lower())


def tokenize(text: str) -> list[str]:
    out = []
    for raw in text.split():
        n = norm(raw)
        if n:
            out.append(n)
    return out


def load_ground_truth(path: Path, default_speaker: str):
    """Return (tokens, tok_speaker, tok_line, n_lines, speaker_line_counts)."""
    tokens: list[str] = []
    tok_speaker: list[str] = []
    tok_line: list[int] = []
    speaker_lines: Counter = Counter()
    line_idx = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        if "|" in raw:
            text, _, spk = raw.rpartition("|")
            spk = spk.strip() or default_speaker
        else:
            text, spk = raw, default_speaker
        speaker_lines[spk] += 1
        for n in tokenize(text):
            tokens.append(n)
            tok_speaker.append(spk)
            tok_line.append(line_idx)
        line_idx += 1
    return tokens, tok_speaker, tok_line, line_idx, speaker_lines


def load_engine(path: Path):
    """Return (tokens, tok_speaker, tok_seg, tok_turn, n_segs, cluster_words)."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    tokens: list[str] = []
    tok_speaker: list[str] = []
    tok_seg: list[int] = []
    tok_turn: list[int] = []
    cluster_words: Counter = Counter()
    for seg_idx, seg in enumerate(doc.get("segments", [])):
        for w in seg.get("words", []):
            n = norm(str(w.get("body", "")))
            if not n:
                continue
            spk = w.get("speaker") or UNKNOWN
            tokens.append(n)
            tok_speaker.append(spk)
            tok_seg.append(seg_idx)
            tok_turn.append(w.get("turnId", seg.get("turnId", -1)))
            cluster_words[spk] += 1
    n_segs = len(doc.get("segments", []))
    return tokens, tok_speaker, tok_seg, tok_turn, n_segs, cluster_words


def align_pairs(gt_tokens, eng_tokens):
    """Yield (gt_index, eng_index) for 1:1 aligned (equal) words."""
    sm = difflib.SequenceMatcher(a=gt_tokens, b=eng_tokens, autojunk=False)
    pairs = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                pairs.append((i1 + k, j1 + k))
    return pairs


def hungarian_one_to_one(confusion, clusters, speakers):
    """Optimal one-to-one cluster->speaker assignment maximizing matched words."""
    try:
        from scipy.optimize import linear_sum_assignment
        import numpy as np
    except Exception:
        return None
    if not clusters or not speakers:
        return None
    cost = np.zeros((len(clusters), len(speakers)))
    for ci, c in enumerate(clusters):
        for si, s in enumerate(speakers):
            cost[ci, si] = -confusion[c].get(s, 0)
    rows, cols = linear_sum_assignment(cost)
    mapping = {clusters[r]: speakers[c] for r, c in zip(rows, cols)}
    matched = int(sum(-cost[r, c] for r, c in zip(rows, cols)))
    return mapping, matched


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stem", help="Episode filename stem (no extension)")
    ap.add_argument("--json-dir", type=Path, default=SCRIPT_DIR / "gen-large-v3")
    ap.add_argument("--gt-dir", type=Path, default=SCRIPT_DIR / "eval" / "ground-truth")
    ap.add_argument("--gt-file", type=Path, default=None,
                    help="Explicit ground-truth file (overrides <gt-dir>/<stem>.txt; "
                    "use the .verified.txt backup when the working file has unfixed prefill)")
    ap.add_argument("--out-dir", type=Path, default=SCRIPT_DIR / "eval" / "scores")
    ap.add_argument("--default-speaker", default="Matt", help="Speaker for unlabeled lines")
    args = ap.parse_args()

    json_path = args.json_dir / f"{args.stem}.json"
    gt_path = args.gt_file if args.gt_file else args.gt_dir / f"{args.stem}.txt"
    for p in (json_path, gt_path):
        if not p.is_file():
            print(f"ERROR: missing {p}", file=sys.stderr)
            return 1

    gt_tok, gt_spk, gt_line, gt_nlines, gt_speaker_lines = load_ground_truth(gt_path, args.default_speaker)
    en_tok, en_spk, en_seg, en_turn, en_nsegs, cluster_words = load_engine(json_path)

    pairs = align_pairs(gt_tok, en_tok)
    n_aligned = len(pairs)
    cov_gt = n_aligned / max(1, len(gt_tok))
    cov_en = n_aligned / max(1, len(en_tok))

    # Confusion: confusion[cluster][true_speaker] = aligned word count
    confusion: dict[str, Counter] = defaultdict(Counter)
    for gi, ei in pairs:
        confusion[en_spk[ei]][gt_spk[gi]] += 1

    clusters = sorted(confusion, key=lambda c: -sum(confusion[c].values()))
    true_speakers = sorted({gt_spk[g] for g, _ in pairs})

    # Many-to-one majority mapping (cluster purity)
    m2o = {c: confusion[c].most_common(1)[0][0] for c in clusters}
    correct_m2o = sum(cnt for c in clusters for s, cnt in confusion[c].items() if s == m2o[c])
    acc_m2o = correct_m2o / max(1, n_aligned)

    # Strict one-to-one optimal mapping (penalizes over-clustering)
    hg = hungarian_one_to_one(confusion, clusters, true_speakers)
    acc_o2o = (hg[1] / max(1, n_aligned)) if hg else None

    # Host-only accuracy (Matt vs Shane) under many-to-one map
    hosts = {"Matt", "Shane"}
    host_total = host_correct = 0
    for c in clusters:
        for s, cnt in confusion[c].items():
            if s in hosts:
                host_total += cnt
                if m2o[c] == s:
                    host_correct += cnt
    acc_hosts = host_correct / host_total if host_total else None

    # Segmentation boundary F1 over aligned consecutive words
    gt_b = set(); en_b = set()
    for k in range(len(pairs) - 1):
        gi, ei = pairs[k]; gi2, ei2 = pairs[k + 1]
        if gt_line[gi2] != gt_line[gi]:
            gt_b.add(k)
        if en_seg[ei2] != en_seg[ei]:
            en_b.add(k)
    tp = len(gt_b & en_b); fp = len(en_b - gt_b); fn = len(gt_b - en_b)
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0

    # ---- Report ----
    W = 66
    def rule(): print("-" * W)
    print("=" * W)
    print(f"SCORE: {args.stem}")
    print("=" * W)
    print(f"Ground-truth speakers : {len(gt_speaker_lines)}  " +
          ", ".join(f"{s}({c})" for s, c in gt_speaker_lines.most_common()))
    print(f"Engine clusters       : {len(clusters)}  (over-clustering x{len(clusters)/max(1,len(gt_speaker_lines)):.1f})")
    print(f"GT lines / engine segs: {gt_nlines} / {en_nsegs}")
    print(f"Words aligned         : {n_aligned}  (GT {cov_gt:.1%}, engine {cov_en:.1%})")
    rule()
    print("SPEAKER ATTRIBUTION (word-level)")
    print(f"  Cluster-purity accuracy (relabel each cluster) : {acc_m2o:.1%}")
    if acc_o2o is not None:
        print(f"  Strict 1:1 accuracy (1 cluster per speaker)    : {acc_o2o:.1%}")
    if acc_hosts is not None:
        print(f"  Host separation Matt-vs-Shane                  : {acc_hosts:.1%}  ({host_correct}/{host_total})")
    rule()
    print("PER-CLUSTER (engine SPEAKER_xx -> your label)")
    print(f"  {'cluster':<12}{'words':>7}  {'->label':<12}{'purity':>7}  mix")
    for c in clusters:
        tot = sum(confusion[c].values())
        top = m2o[c]
        purity = confusion[c][top] / tot
        mix = ", ".join(f"{s}:{n}" for s, n in confusion[c].most_common(4) if s != top) or "-"
        print(f"  {c:<12}{tot:>7}  {top:<12}{purity:>6.0%}  {mix}")
    rule()
    print("SEGMENTATION (vs your re-segmentation)")
    print(f"  boundary  P {prec:.1%}  R {rec:.1%}  F1 {f1:.1%}   (tp {tp}, fp {fp}, fn {fn})")
    rule()
    print("CONFUSION (rows=your speakers, cols=top clusters)")
    show_clusters = clusters[:8]
    print("  " + " " * 12 + "".join(f"{c.replace('SPEAKER_','S'):>7}" for c in show_clusters))
    for s in [x for x in ["Shane", "Matt", "Phil", "Caller", "Theme song"] if x in true_speakers] + \
             [x for x in true_speakers if x not in {"Shane","Matt","Phil","Caller","Theme song"}]:
        row = "".join(f"{confusion[c].get(s,0):>7}" for c in show_clusters)
        print(f"  {s:<12}{row}")

    # ---- Save JSON + disagreement log ----
    args.out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "stem": args.stem,
        "groundTruthSpeakers": dict(gt_speaker_lines),
        "engineClusterCount": len(clusters),
        "gtLines": gt_nlines,
        "engineSegments": en_nsegs,
        "wordsAligned": n_aligned,
        "coverageGt": round(cov_gt, 4),
        "coverageEngine": round(cov_en, 4),
        "attribution": {
            "clusterPurityAccuracy": round(acc_m2o, 4),
            "strictOneToOneAccuracy": round(acc_o2o, 4) if acc_o2o is not None else None,
            "hostSeparationAccuracy": round(acc_hosts, 4) if acc_hosts is not None else None,
        },
        "clusterMapping": {c: {"label": m2o[c], "words": sum(confusion[c].values()),
                               "purity": round(confusion[c][m2o[c]]/sum(confusion[c].values()), 4)}
                           for c in clusters},
        "segmentation": {"precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1, 4),
                         "tp": tp, "fp": fp, "fn": fn},
    }
    out_json = args.out_dir / f"{args.stem}.score.json"
    out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    # Disagreement log: aligned words where engine's mapped label != your label
    dis = args.out_dir / f"{args.stem}.disagreements.txt"
    with dis.open("w", encoding="utf-8", newline="\n") as f:
        f.write("gt_word\ttrue_speaker\tengine_cluster\tmapped_label\n")
        for gi, ei in pairs:
            true = gt_spk[gi]; c = en_spk[ei]
            if m2o.get(c) != true:
                f.write(f"{gt_tok[gi]}\t{true}\t{c}\t{m2o.get(c,'?')}\n")
    print()
    print(f"Saved: {out_json.name}, {dis.name} in {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
