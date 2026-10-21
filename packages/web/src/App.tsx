import { useRoute } from "./route.js";
import { useSession } from "./session.js";
import { Job } from "./screens/Job.js";
import { Jobs } from "./screens/Jobs.js";
import { Login } from "./screens/Login.js";

export function App() {
  const { session, loading } = useSession();
  const route = useRoute();
  if (loading) return null;
  if (!session) return <Login />;
  return route.page === "job" ? <Job key={route.jobId} jobId={route.jobId} view={route.view} /> : <Jobs />;
}
