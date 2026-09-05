import { httpAction } from "./functions";
import {
  catalogClawsFeedV1Handler,
  catalogFeedV1Handler,
  catalogSkillsFeedV1Handler,
  promotionsFeedV1Handler,
} from "./httpApiV1/catalogFeedV1";
import { contentRightsV1Handler } from "./httpApiV1/contentRightsV1";
import { verifyDocsSessionV1Handler } from "./httpApiV1/docsSessionV1";
import { recoverPackagePublishAttemptV1Handler } from "./httpApiV1/packagePublishRecoveryV1";
import {
  exportPluginsV1Handler,
  listBundlePluginsV1Handler,
  listCodePluginsV1Handler,
  listPackagesV1Handler,
  listPluginsV1Handler,
  listPluginCategoriesV1Handler,
  mintPublishTokenV1Handler,
  npmMirrorGetHandler,
  packagesDeleteRouterV1Handler,
  packagesGetRouterV1Handler,
  packagesPostRouterV1Handler,
  pluginsGetRouterV1Handler,
  publishAttemptsGetRouterV1Handler,
  publishPackageV1Handler,
} from "./httpApiV1/packagesV1";
import {
  createPromotionV1Handler,
  listPromotionsV1Handler,
  promotionsGetRouterV1Handler,
  promotionsPostRouterV1Handler,
} from "./httpApiV1/promotionsV1";
import { createPublisherV1Handler } from "./httpApiV1/publishersV1";
import {
  skillsShCatalogPublicV1Handler,
  skillsShCatalogTestV1Handler,
} from "./httpApiV1/skillsShCatalogV1";
import {
  exportSkillsV1Handler,
  listSkillsV1Handler,
  publishSkillV1Handler,
  resolveSkillVersionV1Handler,
  searchSkillsV1Handler,
  skillScanBatchStatusV1Handler,
  skillScanBatchSubmitV1Handler,
  skillScanGetRouterV1Handler,
  skillScanSubmitV1Handler,
  skillSecurityVerdictsV1Handler,
  skillsDeleteRouterV1Handler,
  skillsGetRouterV1Handler,
  skillsPostRouterV1Handler,
} from "./httpApiV1/skillsV1";
import { starsDeleteRouterV1Handler, starsPostRouterV1Handler } from "./httpApiV1/starsV1";
import { transfersGetRouterV1Handler } from "./httpApiV1/transfersV1";
import { trendingV1Handler } from "./httpApiV1/trendingV1";
import {
  banAppealContextV1Handler,
  usersGetRouterV1Handler,
  usersListV1Handler,
  usersPostRouterV1Handler,
} from "./httpApiV1/usersV1";
import { whoamiV1Handler } from "./httpApiV1/whoamiV1";

export const listPackagesV1Http = httpAction(listPackagesV1Handler);
export const listPluginsV1Http = httpAction(listPluginsV1Handler);
export const listPluginCategoriesV1Http = httpAction(listPluginCategoriesV1Handler);
export const exportPluginsV1Http = httpAction(exportPluginsV1Handler);
export const packagesGetRouterV1Http = httpAction(packagesGetRouterV1Handler);
export const packagesPostRouterV1Http = httpAction(packagesPostRouterV1Handler);
export const packagesDeleteRouterV1Http = httpAction(packagesDeleteRouterV1Handler);
export const pluginsGetRouterV1Http = httpAction(pluginsGetRouterV1Handler);
export const publishPackageV1Http = httpAction(publishPackageV1Handler);
export const publishAttemptsGetRouterV1Http = httpAction(publishAttemptsGetRouterV1Handler);
export const mintPublishTokenV1Http = httpAction(mintPublishTokenV1Handler);
export const npmMirrorGetHttp = httpAction(npmMirrorGetHandler);
export const listCodePluginsV1Http = httpAction(listCodePluginsV1Handler);
export const listBundlePluginsV1Http = httpAction(listBundlePluginsV1Handler);
export const verifyDocsSessionV1Http = httpAction(verifyDocsSessionV1Handler);
export const createPublisherV1Http = httpAction(createPublisherV1Handler);
export const contentRightsV1Http = httpAction(contentRightsV1Handler);
export const skillsShCatalogTestV1Http = httpAction(skillsShCatalogTestV1Handler);
export const skillsShCatalogPublicV1Http = httpAction(skillsShCatalogPublicV1Handler);
export const catalogFeedV1Http = httpAction(catalogFeedV1Handler);
export const catalogSkillsFeedV1Http = httpAction(catalogSkillsFeedV1Handler);
export const catalogClawsFeedV1Http = httpAction(catalogClawsFeedV1Handler);
export const promotionsFeedV1Http = httpAction(promotionsFeedV1Handler);

export const searchSkillsV1Http = httpAction(searchSkillsV1Handler);
export const resolveSkillVersionV1Http = httpAction(resolveSkillVersionV1Handler);
export const listSkillsV1Http = httpAction(listSkillsV1Handler);
export const trendingV1Http = httpAction(trendingV1Handler);
export const skillsGetRouterV1Http = httpAction(skillsGetRouterV1Handler);
export const publishSkillV1Http = httpAction(publishSkillV1Handler);
export const skillSecurityVerdictsV1Http = httpAction(skillSecurityVerdictsV1Handler);
export const skillScanSubmitV1Http = httpAction(skillScanSubmitV1Handler);
export const skillScanGetRouterV1Http = httpAction(skillScanGetRouterV1Handler);
export const skillScanBatchSubmitV1Http = httpAction(skillScanBatchSubmitV1Handler);
export const skillScanBatchStatusV1Http = httpAction(skillScanBatchStatusV1Handler);
export const skillsPostRouterV1Http = httpAction(skillsPostRouterV1Handler);
export const skillsDeleteRouterV1Http = httpAction(skillsDeleteRouterV1Handler);
export const exportSkillsV1Http = httpAction(exportSkillsV1Handler);

export const starsPostRouterV1Http = httpAction(starsPostRouterV1Handler);
export const starsDeleteRouterV1Http = httpAction(starsDeleteRouterV1Handler);
export const transfersGetRouterV1Http = httpAction(transfersGetRouterV1Handler);

export const listPromotionsV1Http = httpAction(listPromotionsV1Handler);
export const promotionsGetRouterV1Http = httpAction(promotionsGetRouterV1Handler);
export const createPromotionV1Http = httpAction(createPromotionV1Handler);
export const promotionsPostRouterV1Http = httpAction(promotionsPostRouterV1Handler);

export const whoamiV1Http = httpAction(whoamiV1Handler);
export const usersGetRouterV1Http = httpAction(usersGetRouterV1Handler);
export const usersPostRouterV1Http = httpAction(usersPostRouterV1Handler);
export const usersListV1Http = httpAction(usersListV1Handler);
export const banAppealContextV1Http = httpAction(banAppealContextV1Handler);

export const __handlers = {
  listPackagesV1Handler,
  listPluginsV1Handler,
  listPluginCategoriesV1Handler,
  exportPluginsV1Handler,
  packagesGetRouterV1Handler,
  packagesPostRouterV1Handler,
  packagesDeleteRouterV1Handler,
  pluginsGetRouterV1Handler,
  publishPackageV1Handler,
  publishAttemptsGetRouterV1Handler,
  mintPublishTokenV1Handler,
  npmMirrorGetHandler,
  listCodePluginsV1Handler,
  listBundlePluginsV1Handler,
  verifyDocsSessionV1Handler,
  createPublisherV1Handler,
  contentRightsV1Handler,
  skillsShCatalogTestV1Handler,
  skillsShCatalogPublicV1Handler,
  catalogFeedV1Handler,
  catalogSkillsFeedV1Handler,
  catalogClawsFeedV1Handler,
  searchSkillsV1Handler,
  resolveSkillVersionV1Handler,
  listSkillsV1Handler,
  trendingV1Handler,
  skillsGetRouterV1Handler,
  publishSkillV1Handler,
  skillSecurityVerdictsV1Handler,
  skillScanSubmitV1Handler,
  skillScanGetRouterV1Handler,
  skillScanBatchSubmitV1Handler,
  skillScanBatchStatusV1Handler,
  skillsPostRouterV1Handler,
  skillsDeleteRouterV1Handler,
  exportSkillsV1Handler,
  starsPostRouterV1Handler,
  starsDeleteRouterV1Handler,
  transfersGetRouterV1Handler,
  whoamiV1Handler,
  usersGetRouterV1Handler,
  usersPostRouterV1Handler,
  usersListV1Handler,
  banAppealContextV1Handler,
  listPromotionsV1Handler,
  promotionsGetRouterV1Handler,
  createPromotionV1Handler,
  promotionsPostRouterV1Handler,
  promotionsFeedV1Handler,
};

export const recoverPackagePublishAttemptV1Http = httpAction(recoverPackagePublishAttemptV1Handler);
