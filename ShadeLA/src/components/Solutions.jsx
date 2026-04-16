// src/components/Solutions.jsx
import React, { useMemo, useState } from "react";
import SolutionsTable from "./SolutionsTable";
import solutionsData from "../data/Solutions.json";

function toText(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function buildImgSrc(photoPathFromJson) {
  // JSON: "images/parametric_tree.jpg"
  return `../data/${photoPathFromJson}`;
}

function SolutionsCard({ solution }) {
  if (!solution) {
    return (
      <div
        style={{
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          padding: 16,
          opacity: 0.85,
        }}
      >
        Select a solution from the table to see details.
      </div>
    );
  }

  const imgSrc = buildImgSrc(solution.photo);

  return (
    <div className="panel">
            <img
              src={`/${solution.photo}`}
              alt={solution.name}
              style={{ 
              maxHeight: 326,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
 
              width: "100%", height: "100%", objectFit: "cover" }}
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
        <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2, marginTop: 16 }}>
         {solution.name}
        </div>    
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 10,
            marginTop: 12,
          }}
        >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 24,
            marginBottom: 4,
          }}
        >
          <InfoRow label="Shade Category" value={solution.shadeCategory} />
          <InfoRow label="Primary Material" value={solution.primaryMaterial} />
          <InfoRow label="Tech Integration" value={solution.techIntegration} />
        </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <InfoRow label="Ideal Placement" value={solution.idealPlacement?.title} />
            <InfoRow value={solution.idealPlacement?.description ?? ""} />
          </div>
        </div>
      </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{minWidth:120}}>
      <div
        style={{
          fontSize: 11,
          opacity: 0.65,
          marginBottom: 2,
          letterSpacing: 0.3,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function Solutions() {
  // keep original JSON objects for the card
  const solutions = useMemo(() => solutionsData ?? [], []);

  const [selectedId, setSelectedId] = useState(solutions[0]?.id ?? null);

  const selectedSolution = useMemo(() => {
    return solutions.find((s) => s.id === selectedId) ?? null;
  }, [solutions, selectedId]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.25fr 0.75fr",
        gap: 16,
        alignItems: "start",
        marginTop: 16,
        marginLeft: 8,
      }}
    >
      {/* [section 1] */}
      <div>
        <SolutionsTable
          data={solutions}
          selectedId={selectedId}
          onSelect={(solution) => setSelectedId(solution.id)}
        />
      </div>

      {/* [section 2] */}
      <div>
        <SolutionsCard solution={selectedSolution} />
      </div>
    </div>
  );
}