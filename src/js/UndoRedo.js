import React, { useImperativeHandle } from 'react';
import { DatabaseManager, STORES } from './DatabaseManager';
import { MIN_UNDO_STATES, UNDO_THRESHOLD } from './Constants';

function UndoRedoManager({ terrainBuilderRef, environmentBuilderRef, children }, ref) {
  useImperativeHandle(ref, () => ({
    saveUndo,
    undo,
    redo,
    handleUndo,
    handleRedo
  }));

  const applyStates = async (states, initialTerrain, initialEnvironment) => {
    let newTerrain = { ...initialTerrain };
    let newEnvironment = [...initialEnvironment];

    for (const state of states) {
      // Apply terrain changes
      if (state.terrain) {
        // Remove blocks
        Object.keys(state.terrain.removed || {}).forEach(key => {
          delete newTerrain[key];
        });

        // Add blocks
        Object.entries(state.terrain.added || {}).forEach(([key, value]) => {
          newTerrain[key] = value;
        });
      }

      // Apply environment changes
      if (state.environment?.added || state.environment?.removed) {
        // Remove any objects listed in "removed". Use ±0.001 to match positions.
        newEnvironment = newEnvironment.filter(obj =>
          !(state.environment.removed || []).some(removed =>
            removed.modelUrl === obj.modelUrl &&
            Math.abs(removed.position.x - obj.position.x) < 0.001 &&
            Math.abs(removed.position.y - obj.position.y) < 0.001 &&
            Math.abs(removed.position.z - obj.position.z) < 0.001
          )
        );

        // Add any objects listed in "added"
        if (Array.isArray(state.environment.added)) {
          newEnvironment.push(...state.environment.added);
        }
      }
    }

    return { newTerrain, newEnvironment };
  };

  const commitOldStates = async (undoStates) => {
    try {
      // Keep the most recent MIN_UNDO_STATES
      const statesToKeep = undoStates.slice(0, MIN_UNDO_STATES);
      const statesToCommit = undoStates.slice(MIN_UNDO_STATES);

      // Apply all states in reverse order (oldest → newest)
      const reversedStatesToCommit = [...statesToCommit].reverse();

      // Get current terrain and environment
      const currentTerrain = await DatabaseManager.getData(STORES.TERRAIN, 'current') || {};
      const currentEnv = await DatabaseManager.getData(STORES.ENVIRONMENT, 'current') || [];

      // Apply all states that need to be committed
      const { newTerrain, newEnvironment } = await applyStates(
        reversedStatesToCommit,
        currentTerrain,
        currentEnv
      );

      // Save final state and the trimmed undo stack
      await Promise.all([
        DatabaseManager.saveData(STORES.TERRAIN, 'current', newTerrain),
        DatabaseManager.saveData(STORES.ENVIRONMENT, 'current', newEnvironment),
        DatabaseManager.saveData(STORES.UNDO, 'states', statesToKeep),
        DatabaseManager.saveData(STORES.REDO, 'states', [])
      ]);

      return { newTerrain, newEnvironment };
    } catch (error) {
      console.error('Error committing old states:', error);
      throw error;
    }
  };

  const undo = async () => {
    try {
      const undoStates = await DatabaseManager.getData(STORES.UNDO, 'states') || [];
      if (undoStates.length === 0) return null;

      const [currentUndo, ...remainingUndo] = undoStates;
      const redoStates = await DatabaseManager.getData(STORES.REDO, 'states') || [];

      // Get current terrain and environment
      const currentTerrain = await DatabaseManager.getData(STORES.TERRAIN, 'current') || {};
      const currentEnv = await DatabaseManager.getData(STORES.ENVIRONMENT, 'current') || [];

      // Apply undo changes
      let newTerrain = { ...currentTerrain };
      let newEnvironment = [...currentEnv];

      if (currentUndo.terrain) {
        // Remove added blocks
        Object.keys(currentUndo.terrain.added || {}).forEach(key => {
          delete newTerrain[key];
        });
        // Restore removed blocks
        Object.entries(currentUndo.terrain.removed || {}).forEach(([key, value]) => {
          newTerrain[key] = value;
        });
      }

      if (currentUndo.environment) {
        // Remove any objects that were originally "added" — with ±0.001
        newEnvironment = newEnvironment.filter(obj =>
          !(currentUndo.environment.added || []).some(added =>
            added.modelUrl === obj.modelUrl &&
            Math.abs(added.position.x - obj.position.x) < 0.001 &&
            Math.abs(added.position.y - obj.position.y) < 0.001 &&
            Math.abs(added.position.z - obj.position.z) < 0.001
          )
        );
        // Restore removed objects
        if (Array.isArray(currentUndo.environment.removed)) {
          newEnvironment.push(...currentUndo.environment.removed);
        }
      }

      // Prepare redo state
      const redoChanges = {
        terrain: currentUndo.terrain
          ? {
              added: currentUndo.terrain.added,
              removed: currentUndo.terrain.removed
            }
          : null,
        environment: currentUndo.environment
          ? {
              added: currentUndo.environment.added,
              removed: currentUndo.environment.removed
            }
          : null
      };

      // Save updated state, update undo/redo
      await Promise.all([
        DatabaseManager.saveData(STORES.TERRAIN, 'current', newTerrain),
        DatabaseManager.saveData(STORES.ENVIRONMENT, 'current', newEnvironment),
        DatabaseManager.saveData(STORES.UNDO, 'states', remainingUndo),
        DatabaseManager.saveData(STORES.REDO, 'states', [redoChanges, ...redoStates])
      ]);

      return currentUndo;
    } catch (error) {
      console.error('Error during undo:', error);
      return null;
    }
  };

  const redo = async () => {
    try {
      const redoStates = await DatabaseManager.getData(STORES.REDO, 'states') || [];
      if (redoStates.length === 0) {
        return null;
      }

      const [currentRedo, ...remainingRedo] = redoStates;
      const undoStates = await DatabaseManager.getData(STORES.UNDO, 'states') || [];

      // Get current terrain and environment
      const currentTerrain = await DatabaseManager.getData(STORES.TERRAIN, 'current') || {};
      const currentEnv = await DatabaseManager.getData(STORES.ENVIRONMENT, 'current') || [];

      // Apply redo changes
      let newTerrain = { ...currentTerrain };
      let newEnvironment = [...currentEnv];

      if (currentRedo.terrain) {
        // Re-add blocks that were originally added
        Object.entries(currentRedo.terrain.added || {}).forEach(([key, value]) => {
          newTerrain[key] = value;
        });
        // Remove blocks that were originally removed
        Object.keys(currentRedo.terrain.removed || {}).forEach(key => {
          delete newTerrain[key];
        });
      }

      if (currentRedo.environment) {

        // Remove any objects that were originally removed — with ±0.001
        if (currentRedo.environment.removed?.length > 0) {
          newEnvironment = newEnvironment.filter(obj =>
            !currentRedo.environment.removed.some(removedObj =>
              removedObj.modelUrl === obj.modelUrl &&
              Math.abs(removedObj.position.x - obj.position.x) < 0.001 &&
              Math.abs(removedObj.position.y - obj.position.y) < 0.001 &&
              Math.abs(removedObj.position.z - obj.position.z) < 0.001
            )
          );
        }

        // Then add objects that were originally added
        if (currentRedo.environment.added?.length > 0) {
          newEnvironment = [...newEnvironment, ...currentRedo.environment.added];
        }
      }

      // Prepare undo state for the re-applied changes
      const undoChanges = {
        terrain: currentRedo.terrain
          ? {
              added: currentRedo.terrain.removed,
              removed: currentRedo.terrain.added
            }
          : null,
        environment: currentRedo.environment
          ? {
              added: currentRedo.environment.removed,
              removed: currentRedo.environment.added
            }
          : null
      };

      await Promise.all([
        DatabaseManager.saveData(STORES.TERRAIN, 'current', newTerrain),
        DatabaseManager.saveData(STORES.ENVIRONMENT, 'current', newEnvironment),
        DatabaseManager.saveData(STORES.REDO, 'states', remainingRedo),
        DatabaseManager.saveData(STORES.UNDO, 'states', [undoChanges, ...undoStates])
      ]);

      return currentRedo;
    } catch (error) {
      console.error('Error during redo:', error);
      return null;
    }
  };

  const handleUndo = async () => {
    const undoneChanges = await undo();
    if (undoneChanges) {
      // Re-apply from DB
      if (terrainBuilderRef?.current?.refreshTerrainFromDB) {
        await terrainBuilderRef.current.refreshTerrainFromDB();
      }
      if (environmentBuilderRef?.current?.refreshEnvironmentFromDB) {
        await environmentBuilderRef.current.refreshEnvironmentFromDB();
      }
    }
  };

  const handleRedo = async () => {
    const redoneChanges = await redo();
    if (redoneChanges) {
      // Re-apply from DB
      if (terrainBuilderRef?.current?.refreshTerrainFromDB) {
        await terrainBuilderRef.current.refreshTerrainFromDB();
      }
      if (environmentBuilderRef?.current?.refreshEnvironmentFromDB) {
        await environmentBuilderRef.current.refreshEnvironmentFromDB();
      }
    }
  };

  const saveUndo = async (changes) => {
    try {
      // Get existing undo states
      const undoStates = await DatabaseManager.getData(STORES.UNDO, 'states') || [];

      // Add new changes to undo stack (front)
      const newUndoStates = [changes, ...undoStates];

      // If we exceed threshold, commit older states
      if (newUndoStates.length > UNDO_THRESHOLD) {
        await commitOldStates(newUndoStates);
      } else {
        // Otherwise just save the new state
        await Promise.all([
          DatabaseManager.saveData(STORES.UNDO, 'states', newUndoStates),
          DatabaseManager.saveData(STORES.REDO, 'states', [])
        ]);
      }
    } catch (error) {
      console.error('Error saving undo state:', error);
    }
  };

  // Keyboard shortcuts for Ctrl+Z / Ctrl+Y
  React.useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey) {
        if (event.key === 'z') {
          event.preventDefault();
          if (event.shiftKey) {
            handleRedo();
          } else {
            handleUndo();
          }
        } else if (event.key === 'y') {
          event.preventDefault();
          handleRedo();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <>
      {children}
    </>
  );
}

export default React.forwardRef(UndoRedoManager);
