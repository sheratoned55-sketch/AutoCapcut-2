import { StoreProvider, useStore } from './store';
import { HomeScreen } from './components/HomeScreen';
import { EditorScreen } from './components/EditorScreen';

function AppInner() {
  const { currentProject } = useStore();
  return currentProject ? <EditorScreen /> : <HomeScreen />;
}

export default function App() {
  return (
    <StoreProvider>
      <AppInner />
    </StoreProvider>
  );
}
