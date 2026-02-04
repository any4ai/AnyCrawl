import express, { Router, ErrorRequestHandler } from "express";
import { ScrapeController } from "../../controllers/v1/ScrapeController.js";
import { SearchController } from "../../controllers/v1/SearchController.js";
import { CrawlController } from "../../controllers/v1/CrawlController.js";
import { MapController } from "../../controllers/v1/MapController.js";
import { ScheduledTasksController } from "../../controllers/v1/ScheduledTasksController.js";
import { WebhooksController } from "../../controllers/v1/WebhooksController.js";
import { controllerWrapper } from "../../utils/AsyncHandler.js";

const router: express.Router = Router();
const scrapeController = new ScrapeController();
const searchController = new SearchController();
const crawlController = new CrawlController();
const mapController = new MapController();
const scheduledTasksController = new ScheduledTasksController();
const webhooksController = new WebhooksController();

router.post("/scrape", controllerWrapper(scrapeController.handle));
router.post("/search", controllerWrapper(searchController.handle));
router.post("/map", controllerWrapper(mapController.map));

// Crawl routes
router.post("/crawl", controllerWrapper(crawlController.start));
router.get("/crawl/:jobId/status", controllerWrapper(crawlController.status));
router.get("/crawl/:jobId", controllerWrapper(crawlController.results));
router.delete("/crawl/:jobId", controllerWrapper(crawlController.cancel));

// Scheduled tasks routes
router.post("/scheduled-tasks", controllerWrapper(scheduledTasksController.create));
router.get("/scheduled-tasks", controllerWrapper(scheduledTasksController.list));
router.get("/scheduled-tasks/:taskId", controllerWrapper(scheduledTasksController.get));
router.put("/scheduled-tasks/:taskId", controllerWrapper(scheduledTasksController.update));
router.patch("/scheduled-tasks/:taskId/pause", controllerWrapper(scheduledTasksController.pause));
router.patch("/scheduled-tasks/:taskId/resume", controllerWrapper(scheduledTasksController.resume));
router.delete("/scheduled-tasks/:taskId", controllerWrapper(scheduledTasksController.delete));
router.get("/scheduled-tasks/:taskId/executions", controllerWrapper(scheduledTasksController.executions));

// Webhooks routes
router.post("/webhooks", controllerWrapper(webhooksController.create));
router.get("/webhooks", controllerWrapper(webhooksController.list));
router.get("/webhooks/:webhookId", controllerWrapper(webhooksController.get));
router.put("/webhooks/:webhookId", controllerWrapper(webhooksController.update));
router.delete("/webhooks/:webhookId", controllerWrapper(webhooksController.delete));
router.get("/webhooks/:webhookId/deliveries", controllerWrapper(webhooksController.deliveries));
router.post("/webhooks/:webhookId/test", controllerWrapper(webhooksController.test));
router.put("/webhooks/:webhookId/activate", controllerWrapper(webhooksController.activate));
router.put("/webhooks/:webhookId/deactivate", controllerWrapper(webhooksController.deactivate));
router.post("/webhooks/:webhookId/deliveries/:deliveryId/replay", controllerWrapper(webhooksController.replayDelivery));
router.get("/webhook-events", controllerWrapper(webhooksController.getEvents));

// Error handler
router.use(((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send("Something broke!");
}) as ErrorRequestHandler);

export default router;
