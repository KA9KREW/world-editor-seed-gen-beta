import { DatabaseManager, STORES } from "./DatabaseManager";
import { getBlockTypes, processCustomBlock } from "./TerrainBuilder";
import { environmentModels } from "./EnvironmentBuilder";
import * as THREE from "three";
import JSZip from "jszip";
import { version } from "./Constants";


export const importMap = async (file, terrainBuilderRef, environmentBuilderRef) => {
  try {
    const reader = new FileReader();
    
    return new Promise((resolve, reject) => {
      reader.onload = async (event) => {
        try {
          // get the data from the event, and convert it to a json object
          const importData = JSON.parse(event.target.result);

          console.log("Importing map data:", importData);
          
          let terrainData = {};
          let environmentData = [];
          
          // Lets make sure there is data at all
          if (importData.blocks) {
              
            // Process any custom blocks first
            if (importData.blockTypes && importData.blockTypes.length > 0) {
              console.log(`Processing ${importData.blockTypes.length} block types from import`);
              
              // Process each block type, ensuring custom blocks are properly handled
              for (const blockType of importData.blockTypes) {
                // Only process blocks that are custom or have IDs in the custom range (100-199)
                if (blockType.isCustom || (blockType.id >= 100 && blockType.id < 200)) {
                  console.log(`Processing custom block: ${blockType.name} (ID: ${blockType.id})`);
                  
                  // Make sure the block has all required properties
                  const processedBlock = {
                    id: blockType.id,
                    name: blockType.name,
                    textureUri: blockType.textureUri,
                    isCustom: true,
                    isMultiTexture: blockType.isMultiTexture || false,
                    sideTextures: blockType.sideTextures || {}
                  };
                  
                  // Process the custom block
                  await processCustomBlock(processedBlock);
                }
              }
              
              // Dispatch event to notify that custom blocks have been loaded
              window.dispatchEvent(new CustomEvent('custom-blocks-loaded', {
                detail: { 
                  blocks: importData.blockTypes.filter(b => b.isCustom || (b.id >= 100 && b.id < 200))
                }
              }));
            }

            // Now process terrain data
            terrainData = Object.entries(importData.blocks).reduce((acc, [key, blockId]) => {
              acc[key] = blockId;
              return acc;
            }, {});
            
            // Convert entities to environment format
            if (importData.entities) {
              environmentData = Object.entries(importData.entities)
                .map(([key, entity], index) => {
                  const [x, y, z] = key.split(',').map(Number);
                  
                  // Convert rotation from quaternion to euler angles
                  const quaternion = new THREE.Quaternion(
                    entity.rigidBodyOptions.rotation.x,
                    entity.rigidBodyOptions.rotation.y,
                    entity.rigidBodyOptions.rotation.z,
                    entity.rigidBodyOptions.rotation.w
                  );
                  const euler = new THREE.Euler().setFromQuaternion(quaternion);

                  // Get model name from the file path
                  const modelName = entity.modelUri.split('/').pop().replace('.gltf', '');
                  const matchingModel = environmentModels.find(model => model.name === modelName);

                  // Calculate the vertical offset to subtract
                  const boundingBoxHeight = matchingModel?.boundingBoxHeight || 1;
                  const verticalOffset = (boundingBoxHeight * entity.modelScale) / 2;
                  const adjustedY = y - 0.5 - verticalOffset;

                  return {
                    position: { x, y: adjustedY, z },
                    rotation: { x: euler.x, y: euler.y, z: euler.z },
                    scale: { x: entity.modelScale, y: entity.modelScale, z: entity.modelScale },
                    modelUrl: matchingModel ? matchingModel.modelUrl : `assets/${entity.modelUri}`,
                    name: modelName,
                    modelLoopedAnimations: entity.modelLoopedAnimations || ["idle"],
                    // Add instanceId to each object - this is critical!
                    instanceId: index // Use the array index as a unique ID
                  };
                })
                .filter(obj => obj !== null);
              
              console.log(`Imported ${environmentData.length} environment objects`);
            }
          } else {
            alert("Invalid map file format - no valid map data found");
            return;
          }
          
          // Save terrain data
          await DatabaseManager.saveData(STORES.TERRAIN, "current", terrainData);
          
          // Save environment data
          await DatabaseManager.saveData(STORES.ENVIRONMENT, "current", environmentData);
          
          // Refresh terrain and environment builders
          if (terrainBuilderRef && terrainBuilderRef.current) {
            await terrainBuilderRef.current.refreshTerrainFromDB();
          }
          
          if (environmentBuilderRef && environmentBuilderRef.current) {
            // Wait for environment refresh to complete
            await environmentBuilderRef.current.refreshEnvironmentFromDB();
          }
          
          resolve();
        } catch (error) {
          console.error("Error processing import:", error);
          reject(error);
        }
      };
      
      reader.onerror = () => {
        reject(new Error("Error reading file"));
      };
      
      reader.readAsText(file);
    });
  } catch (error) {
    console.error("Error importing map:", error);
    alert("Error importing map. Please try again.");
    throw error;
  }
};


export const exportMapFile = async (terrainBuilderRef) => {
  try {
    // First try to get terrain data from terrainBuilderRef
    let terrainData = terrainBuilderRef.current?.getCurrentTerrainData();
    
    // If terrainBuilderRef doesn't have data, try getting it directly from the database
    if (!terrainData || Object.keys(terrainData).length === 0) {
      console.log("No terrain data in terrainRef, checking database directly...");
      terrainData = await DatabaseManager.getData(STORES.TERRAIN, "current");
      
      // Check if we got data from the database
      if (!terrainData || Object.keys(terrainData).length === 0) {
        console.error("No terrain data found in database");
        alert("No map found to export! Please generate a world or place some blocks first.");
        return;
      }
      
      console.log("Found terrain data in database:", Object.keys(terrainData).length, "blocks");
    }

    // Get environment data
    const environmentObjects = await DatabaseManager.getData(STORES.ENVIRONMENT, "current") || [];

    // Simplify terrain data to just include block IDs
    const simplifiedTerrain = Object.entries(terrainData).reduce((acc, [key, value]) => {
      if (key.split(",").length === 3) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const allBlockTypes = getBlockTypes();
    console.log("Exporting block types:", allBlockTypes);

    // Create the export object with properly formatted block types
    const exportData = {
      blockTypes: allBlockTypes.map(block => {
        // For custom blocks, preserve the exact texture URI
        if (block.isCustom || block.id >= 100) {
          return {
            id: block.id,
            name: block.name,
            textureUri: block.textureUri, // Keep the original texture URI for custom blocks
            isCustom: true,
            isMultiTexture: block.isMultiTexture || false,
            sideTextures: block.sideTextures || {}
          };
        } else {
          // For standard blocks, use the normalized path format
          return {
            id: block.id,
            name: block.name,
            textureUri: block.isMultiTexture ? `blocks/${block.name}` : `blocks/${block.name}.png`,
            isCustom: false,
            isMultiTexture: block.isMultiTexture || false,
            sideTextures: block.sideTextures || {}
          };
        }
      }),
      blocks: simplifiedTerrain,
      entities: environmentObjects.reduce((acc, obj) => {
        const entityType = environmentModels.find((model) => model.modelUrl === obj.modelUrl);

        if (entityType) {
          const quaternion = new THREE.Quaternion();
          quaternion.setFromEuler(new THREE.Euler(obj.rotation.x, obj.rotation.y, obj.rotation.z));

          const modelUri = entityType.isCustom ? `models/environment/${entityType.name}.gltf` : obj.modelUrl.replace("assets/", "");

          // Calculate adjusted Y position
          const boundingBoxHeight = entityType.boundingBoxHeight || 1;
          const verticalOffset = (boundingBoxHeight * obj.scale.y) / 2;
          const adjustedY = obj.position.y + 0.5 + verticalOffset;

          // Use adjusted Y in the key
          const key = `${obj.position.x},${adjustedY},${obj.position.z}`;

          acc[key] = {
            modelUri: modelUri,
            modelLoopedAnimations: entityType.animations || ["idle"],
            modelScale: obj.scale.x,
            name: entityType.name,
            rigidBodyOptions: {
              type: "kinematic_velocity",
              rotation: {
                x: quaternion.x,
                y: quaternion.y,
                z: quaternion.z,
                w: quaternion.w,
              },
            },
          };
        }
        return acc;
      }, {}),
      version: version || "1.0.0"
    };

    // Convert to JSON and create a blob
    const jsonContent = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonContent], { type: "application/json" });
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "terrain.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Error exporting map file:", error);
    alert("Error exporting map. Please try again.");
    throw error;
  }
};
