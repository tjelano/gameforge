import { DriveBrowser } from './DriveBrowser';

export default function DrivePage() {
  return (
    <>
      <h1 className="page-title">Drive</h1>
      <p className="page-subtitle">Browse, upload, and organize files in your shared Drive without leaving GameForge.</p>
      <DriveBrowser />
    </>
  );
}
