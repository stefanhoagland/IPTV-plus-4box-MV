export default function MultiviewPage() {
  return (
    <div className="grid-2x2">
      {[1, 2, 3, 4].map((n) => (
        <div key={n} className="tile">
          <span className="muted">Box {n}</span>
          <small className="muted">Channel picking arrives in step 3</small>
        </div>
      ))}
    </div>
  );
}
