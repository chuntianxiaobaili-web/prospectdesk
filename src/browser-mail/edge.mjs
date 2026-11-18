import {forBrowser} from './connection.mjs';
export const browserId='edge';
export const connectEdge=options=>forBrowser(browserId,options);
export default connectEdge;
