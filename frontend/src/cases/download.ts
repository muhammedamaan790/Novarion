// Save a Blob as a file (exports, backups, snapshots). Kept separate from snapshot.ts so that the PDF and 3D code it
// needs load only when a Review Snapshot is actually made.
export function download(filename: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
