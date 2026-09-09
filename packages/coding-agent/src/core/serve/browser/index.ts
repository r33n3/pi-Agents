import "./app.ts";
import "./browser-setup.ts";
import { installCatalogPublication } from "./catalog-publication.ts";
import { installConversationControls } from "./conversation-controls.ts";
import { installConversationLayout } from "./conversation-layout.ts";
import { installHistoryLayout } from "./history-layout.ts";
import { installNavigation } from "./navigation.ts";
import { installSettingsPresentation } from "./settings-presentation.ts";

installNavigation();
installConversationControls();
installConversationLayout();
installSettingsPresentation();
installHistoryLayout();
installCatalogPublication();
