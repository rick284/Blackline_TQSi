import { useRoute } from "./route.js";
import { useSession } from "./session.js";
import { ContactsPage } from "./screens/ContactsPage.js";
import { Job } from "./screens/Job.js";
import { Jobs } from "./screens/Jobs.js";
import { Library } from "./screens/Library.js";
import { Login } from "./screens/Login.js";

export function App() {
  const { session, loading } = useSession();
  const route = useRoute();
  if (loading) return null;
  if (!session) return <Login />;
  if (route.page === "library") return <Library />;
  if (route.page === "contacts") return <ContactsPage tab={route.tab} />;
  return route.page === "job" ? <Job key={route.jobId} jobId={route.jobId} view={route.view} /> : <Jobs />;
}
