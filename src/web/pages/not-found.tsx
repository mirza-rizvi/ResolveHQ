import { ArrowLeft, Compass } from "lucide-react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
  return <div className="placeholder-page"><Compass size={24} /><h1>Page not found</h1><p>That address does not exist in this workspace. It may have been renamed or removed.</p><Link to="/inbox"><ArrowLeft size={15} />Return to inbox</Link></div>;
}
