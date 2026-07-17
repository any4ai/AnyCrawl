export class AnyCrawlClient {
    healthCheck = jest.fn();
    scrape = jest.fn();
    crawl = jest.fn();
    createCrawl = jest.fn();
    getCrawlStatus = jest.fn();
    getCrawlResults = jest.fn();
    cancelCrawl = jest.fn();
    search = jest.fn();
    constructor(_apiKey: string, _baseUrl?: string) { }
}

export default { AnyCrawlClient };

