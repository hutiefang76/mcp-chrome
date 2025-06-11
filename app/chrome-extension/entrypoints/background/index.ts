import { initNativeHostListener } from './native-host';
import { initSemanticSimilarityListener } from './semantic-similarity';
import { initStorageManagerListener } from './storage-manager';
import { vectorSearchTabsContentTool } from './tools/browser/vector-search';
import { ERROR_MESSAGES } from '@/common/constants';

/**
 * Background script entry point
 * Initializes all background services and listeners
 */
export default defineBackground(() => {
  // Initialize core services
  initNativeHostListener();
  initSemanticSimilarityListener();
  initStorageManagerListener();

  // Initialize vector search tool and handle potential errors
  vectorSearchTabsContentTool.getIndexStats().catch((error) => {
    console.error(
      `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: VectorSearchTabsContentTool initialization`,
      error,
    );
  });

  // Note: Semantic similarity engine initialization is now user-controlled via popup
  console.log('Background: Semantic similarity engine initialization is now user-controlled');
});
