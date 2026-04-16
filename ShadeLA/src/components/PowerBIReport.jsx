import React from "react";

function PowerBIReport() {
  const embedUrl =
    "https://app.powerbi.com/view?r=eyJrIjoiZjIzY2MxM2QtYjczOC00NmRlLTk4MmYtOGM4YjVhMjc4ZWRhIiwidCI6ImVlYzI2MzU0LWYxNjItNGUwMC1hMzBiLTg1NmQ0MDU4NDU5ZiIsImMiOjZ9";

  const scale = 1.2;

  return (
    <div className="powerbi-wrapper-outer">
      <iframe
        className="powerbi-embed"
        title="ShadeLa"
        src={embedUrl}
        style={{
          width: `${100 / scale}%`,
          height: `${100 / scale}%`,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
        allowFullScreen
      />
    </div>
  );
}

export default PowerBIReport;
