const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { createLogger } = require('../utils/logger');
const ethers = require('ethers');

const logger = createLogger('ddcNFTMetadataService');

// DDC NFT 配置
const DDC_NFT_CONFIG = {
  contractAddress: '0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2',
  baseUrl: 'https://api.datadance.ai/metadata/ddcnft',
  keyHash: '0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d',
  supportedTokenIds: [1, 2]
};

/**
 * 初始化 ethers provider 和合约实例
 * @returns {object} { provider, contract }
 */
function getContractInstance() {
  // 使用环境变量配置 RPC URL，如果没有则使用默认值
  const RPC_URL = process.env.DDC_RPC_URL || 'https://dev-exp-alpha.datadance.ai/eth/rpc';
  const CHAIN_ID = process.env.DDC_CHAIN_ID ? parseInt(process.env.DDC_CHAIN_ID, 10) : 44508;
  
  // 创建 provider，参考 web3Utils.js 的配置方式
  // 某些 RPC 节点需要禁用批处理
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
    batchMaxCount: 1,
  });
  
  // ERC721 Metadata 标准 ABI（用于查询 tokenURI 等）
  const ERC721_METADATA_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)'
  ];
  
  const contract = new ethers.Contract(
    DDC_NFT_CONFIG.contractAddress,
    ERC721_METADATA_ABI,
    provider
  );
  
  return { provider, contract };
}

/**
 * 根据 tokenId 获取 metadata
 * @param {number} tokenId 
 * @param {object} user 当前用户（可选）
 * @returns {Promise<object|null>}
 */
async function getMetadataByTokenId(tokenId, user = null) {
  try {
    // 基础 metadata 结构（符合 ERC721 Metadata 标准）
    const baseMetadata = {
      name: `DDC NFT #${tokenId}`,
      description: `DataDance Chain NFT Token #${tokenId}`,
      image: `${DDC_NFT_CONFIG.baseUrl}/${tokenId}/image`,
      external_url: `${DDC_NFT_CONFIG.baseUrl}/${tokenId}`,
      attributes: [
        {
          trait_type: 'Token ID',
          value: tokenId.toString()
        },
        {
          trait_type: 'Contract Address',
          value: DDC_NFT_CONFIG.contractAddress
        },
        {
          trait_type: 'Key Hash',
          value: DDC_NFT_CONFIG.keyHash
        }
      ]
    };

    // 尝试从链上获取 tokenURI（如果合约支持）
    try {
      const { contract } = getContractInstance();
      
      // 查询链上的 tokenURI（如果合约实现了这个函数）
      try {
        const tokenURI = await contract.tokenURI(tokenId);
        if (tokenURI && tokenURI !== '') {
          logger.info('Found tokenURI on-chain', { tokenId, tokenURI });
          // 如果链上有 tokenURI，可以解析它
          // 这里暂时保留基础 metadata，可以根据需要扩展
        }
      } catch (tokenURIError) {
        // 合约可能没有实现 tokenURI，这是正常的
        logger.debug('tokenURI not available on contract', { tokenId });
      }
      
      // 查询 token 的 owner（如果合约实现了 ownerOf）
      try {
        const owner = await contract.ownerOf(tokenId);
        baseMetadata.attributes.push({
          trait_type: 'On-chain Owner',
          value: owner
        });
      } catch (ownerError) {
        logger.debug('ownerOf not available', { tokenId });
      }
    } catch (chainError) {
      logger.warn('Failed to query chain data', {
        error: chainError.message,
        tokenId
      });
    }

    // 如果用户已登录，可以添加用户特定的信息
    if (user) {
      baseMetadata.attributes.push({
        trait_type: 'Requested By',
        value: user.email || user.id
      });
    }

    // 可以根据 tokenId 从数据库查询更详细的信息
    // 例如：如果 tokenId 对应某个 DataNFT
    try {
      // TODO: 根据实际业务需求，可以从数据库查询对应的 DataNFT
      // const dataNFT = await prisma.dataNFT.findFirst({
      //   where: {
      //     // 假设有一个字段存储 tokenId
      //     tokenId: tokenId.toString()
      //   }
      // });
      
      // if (dataNFT) {
      //   baseMetadata.name = dataNFT.name || baseMetadata.name;
      //   baseMetadata.description = dataNFT.description || baseMetadata.description;
      //   baseMetadata.image = dataNFT.image || baseMetadata.image;
      //   // 添加更多属性...
      // }
    } catch (dbError) {
      logger.warn('Database query failed, using default metadata', { 
        error: dbError.message,
        tokenId 
      });
    }

    return baseMetadata;
  } catch (error) {
    logger.error('Error getting metadata by tokenId', {
      error: error.message,
      tokenId
    });
    throw error;
  }
}

/**
 * 验证 tokenId 是否支持
 * @param {number} tokenId 
 * @returns {boolean}
 */
function isTokenIdSupported(tokenId) {
  return DDC_NFT_CONFIG.supportedTokenIds.includes(tokenId);
}

/**
 * 获取配置信息
 * @returns {object}
 */
function getConfig() {
  return {
    ...DDC_NFT_CONFIG
  };
}

/**
 * 使用 ethers 查询链上信息
 * @param {number} tokenId 
 * @returns {Promise<object>}
 */
async function getOnChainInfo(tokenId) {
  try {
    const { contract } = getContractInstance();
    const info = {};
    
    // 查询合约名称和符号
    try {
      info.name = await contract.name();
      info.symbol = await contract.symbol();
    } catch (error) {
      logger.debug('Contract name/symbol not available', { tokenId });
    }
    
    // 查询 token owner
    try {
      info.owner = await contract.ownerOf(tokenId);
    } catch (error) {
      logger.debug('Token owner not available', { tokenId });
    }
    
    return info;
  } catch (error) {
    logger.error('Error getting on-chain info', {
      error: error.message,
      tokenId
    });
    return {};
  }
}

module.exports = {
  getMetadataByTokenId,
  isTokenIdSupported,
  getConfig,
  getOnChainInfo,
  getContractInstance,
  DDC_NFT_CONFIG
};

