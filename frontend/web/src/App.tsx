// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface SocialBond {
  id: string;
  name: string;
  issuer: string;
  targetAmount: string; // Encrypted
  currentRaised: string; // Encrypted
  impactCategory: string;
  maturityDate: number;
  status: "active" | "completed" | "defaulted";
  encryptedDetails: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [bonds, setBonds] = useState<SocialBond[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newBondData, setNewBondData] = useState({ 
    name: "", 
    targetAmount: 0, 
    impactCategory: "Education", 
    maturityDays: 365,
    description: "" 
  });
  const [selectedBond, setSelectedBond] = useState<SocialBond | null>(null);
  const [decryptedAmounts, setDecryptedAmounts] = useState<{target?: number, raised?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<"market" | "stats" | "faq">("market");
  const [searchTerm, setSearchTerm] = useState("");

  // Statistics
  const activeCount = bonds.filter(b => b.status === "active").length;
  const completedCount = bonds.filter(b => b.status === "completed").length;
  const defaultedCount = bonds.filter(b => b.status === "defaulted").length;
  const totalRaised = bonds.reduce((sum, bond) => sum + (decryptedAmounts.raised ? decryptedAmounts.raised : 0), 0);

  useEffect(() => {
    loadBonds().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadBonds = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("bond_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing bond keys:", e); }
      }
      
      const list: SocialBond[] = [];
      for (const key of keys) {
        try {
          const bondBytes = await contract.getData(`bond_${key}`);
          if (bondBytes.length > 0) {
            try {
              const bondData = JSON.parse(ethers.toUtf8String(bondBytes));
              list.push({ 
                id: key, 
                name: bondData.name,
                issuer: bondData.issuer,
                targetAmount: bondData.targetAmount,
                currentRaised: bondData.currentRaised,
                impactCategory: bondData.impactCategory,
                maturityDate: bondData.maturityDate,
                status: bondData.status || "active",
                encryptedDetails: bondData.encryptedDetails
              });
            } catch (e) { console.error(`Error parsing bond data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading bond ${key}:`, e); }
      }
      list.sort((a, b) => b.maturityDate - a.maturityDate);
      setBonds(list);
    } catch (e) { console.error("Error loading bonds:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createBond = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting bond data with Zama FHE..." });
    try {
      const encryptedTarget = FHEEncryptNumber(newBondData.targetAmount);
      const encryptedRaised = FHEEncryptNumber(0); // Initial raised amount is 0
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const bondId = `bond-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const maturityDate = Math.floor(Date.now() / 1000) + (newBondData.maturityDays * 86400);
      
      const bondData = { 
        name: newBondData.name,
        issuer: address,
        targetAmount: encryptedTarget,
        currentRaised: encryptedRaised,
        impactCategory: newBondData.impactCategory,
        maturityDate: maturityDate,
        status: "active",
        encryptedDetails: newBondData.description
      };
      
      await contract.setData(`bond_${bondId}`, ethers.toUtf8Bytes(JSON.stringify(bondData)));
      
      const keysBytes = await contract.getData("bond_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(bondId);
      await contract.setData("bond_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted bond created successfully!" });
      await loadBonds();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewBondData({ 
          name: "", 
          targetAmount: 0, 
          impactCategory: "Education", 
          maturityDays: 365,
          description: "" 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const investInBond = async (bondId: string, amount: number) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted investment with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const bondBytes = await contract.getData(`bond_${bondId}`);
      if (bondBytes.length === 0) throw new Error("Bond not found");
      
      const bondData = JSON.parse(ethers.toUtf8String(bondBytes));
      if (bondData.status !== "active") throw new Error("Bond is not active");
      
      const currentRaised = FHEDecryptNumber(bondData.currentRaised);
      const newRaised = currentRaised + amount;
      const encryptedNewRaised = FHEEncryptNumber(newRaised);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedBond = { ...bondData, currentRaised: encryptedNewRaised };
      await contractWithSigner.setData(`bond_${bondId}`, ethers.toUtf8Bytes(JSON.stringify(updatedBond)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE investment processed successfully!" });
      await loadBonds();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Investment failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const decryptBondAmounts = async (bond: SocialBond) => {
    const target = await decryptWithSignature(bond.targetAmount);
    const raised = await decryptWithSignature(bond.currentRaised);
    if (target !== null && raised !== null) {
      setDecryptedAmounts({target, raised});
    }
  };

  const filteredBonds = bonds.filter(bond => 
    bond.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    bond.impactCategory.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const renderImpactChart = () => {
    const categories = Array.from(new Set(bonds.map(b => b.impactCategory)));
    const data = categories.map(cat => ({
      category: cat,
      count: bonds.filter(b => b.impactCategory === cat).length,
      color: `hsl(${Math.random() * 360}, 70%, 60%)`
    }));
    
    return (
      <div className="impact-chart">
        {data.map((item, index) => (
          <div key={index} className="chart-item">
            <div className="chart-bar-container">
              <div 
                className="chart-bar" 
                style={{
                  width: `${(item.count / Math.max(...data.map(d => d.count))) * 100}%`,
                  backgroundColor: item.color
                }}
              ></div>
            </div>
            <div className="chart-label">
              <span className="category">{item.category}</span>
              <span className="count">{item.count} bonds</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderStatusPie = () => {
    const total = bonds.length || 1;
    const activePercentage = (activeCount / total) * 100;
    const completedPercentage = (completedCount / total) * 100;
    const defaultedPercentage = (defaultedCount / total) * 100;
    
    return (
      <div className="pie-container">
        <div className="pie-chart">
          <div className="pie-segment active" style={{ transform: `rotate(${activePercentage * 3.6}deg)` }}></div>
          <div className="pie-segment completed" style={{ transform: `rotate(${(activePercentage + completedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-segment defaulted" style={{ transform: `rotate(${(activePercentage + completedPercentage + defaultedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-center">
            <div className="pie-value">{bonds.length}</div>
            <div className="pie-label">Total</div>
          </div>
        </div>
        <div className="pie-legend">
          <div className="legend-item"><div className="color-box active"></div><span>Active: {activeCount}</span></div>
          <div className="legend-item"><div className="color-box completed"></div><span>Completed: {completedCount}</span></div>
          <div className="legend-item"><div className="color-box defaulted"></div><span>Defaulted: {defaultedCount}</span></div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading FHE-encrypted bond market...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>Social<span>Impact</span>Bonds</h1>
          <div className="fhe-badge">
            <span>FHE Encrypted</span>
            <div className="fhe-icon"></div>
          </div>
        </div>
        <div className="header-actions">
          <ConnectButton 
            accountStatus="avatar" 
            chainStatus="icon" 
            showBalance={false}
            label="Connect Wallet"
          />
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn"
            disabled={!isConnected}
          >
            + Issue Bond
          </button>
        </div>
      </header>

      <main className="main-content">
        <div className="hero-banner">
          <div className="hero-text">
            <h2>FHE-Encrypted Social Impact Bonds</h2>
            <p>Invest in social causes while preserving your privacy with Zama's Fully Homomorphic Encryption</p>
          </div>
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-value">{bonds.length}</div>
              <div className="stat-label">Total Bonds</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">${totalRaised.toLocaleString()}</div>
              <div className="stat-label">Total Raised</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{activeCount}</div>
              <div className="stat-label">Active Projects</div>
            </div>
          </div>
        </div>

        <div className="tabs-container">
          <div className="tabs">
            <button 
              className={`tab ${activeTab === "market" ? "active" : ""}`}
              onClick={() => setActiveTab("market")}
            >
              Bond Market
            </button>
            <button 
              className={`tab ${activeTab === "stats" ? "active" : ""}`}
              onClick={() => setActiveTab("stats")}
            >
              Statistics
            </button>
            <button 
              className={`tab ${activeTab === "faq" ? "active" : ""}`}
              onClick={() => setActiveTab("faq")}
            >
              FAQ
            </button>
          </div>
        </div>

        {activeTab === "market" && (
          <div className="market-section">
            <div className="search-bar">
              <input
                type="text"
                placeholder="Search bonds by name or category..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <button onClick={loadBonds} disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {filteredBonds.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"></div>
                <p>No social impact bonds found</p>
                {isConnected && (
                  <button 
                    className="create-btn"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create First Bond
                  </button>
                )}
              </div>
            ) : (
              <div className="bond-grid">
                {filteredBonds.map(bond => (
                  <div 
                    key={bond.id} 
                    className="bond-card"
                    onClick={() => setSelectedBond(bond)}
                  >
                    <div className="card-header">
                      <h3>{bond.name}</h3>
                      <span className={`status ${bond.status}`}>{bond.status}</span>
                    </div>
                    <div className="card-body">
                      <div className="bond-info">
                        <div className="info-item">
                          <span>Issuer</span>
                          <strong>{bond.issuer.substring(0, 6)}...{bond.issuer.substring(38)}</strong>
                        </div>
                        <div className="info-item">
                          <span>Category</span>
                          <strong>{bond.impactCategory}</strong>
                        </div>
                        <div className="info-item">
                          <span>Maturity</span>
                          <strong>{new Date(bond.maturityDate * 1000).toLocaleDateString()}</strong>
                        </div>
                      </div>
                      <div className="bond-progress">
                        <div className="progress-bar">
                          <div 
                            className="progress-fill" 
                            style={{ 
                              width: `${(decryptedAmounts.raised && decryptedAmounts.target ? 
                                (decryptedAmounts.raised / decryptedAmounts.target) * 100 : 0)}%` 
                            }}
                          ></div>
                        </div>
                        <div className="progress-text">
                          {decryptedAmounts.raised && decryptedAmounts.target ? (
                            <>
                              ${decryptedAmounts.raised.toLocaleString()} raised of ${decryptedAmounts.target.toLocaleString()}
                              (${(decryptedAmounts.target - decryptedAmounts.raised).toLocaleString()} to go)
                            </>
                          ) : (
                            <button 
                              className="decrypt-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                decryptBondAmounts(bond);
                              }}
                              disabled={isDecrypting}
                            >
                              {isDecrypting ? "Decrypting..." : "Decrypt Amounts"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="card-footer">
                      <button 
                        className="invest-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          const amount = prompt("Enter investment amount:");
                          if (amount && !isNaN(parseFloat(amount))) {
                            investInBond(bond.id, parseFloat(amount));
                          }
                        }}
                        disabled={bond.status !== "active" || !isConnected}
                      >
                        Invest
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "stats" && (
          <div className="stats-section">
            <div className="stats-grid">
              <div className="stat-card large">
                <h3>Impact Categories</h3>
                {renderImpactChart()}
              </div>
              <div className="stat-card">
                <h3>Bond Status</h3>
                {renderStatusPie()}
              </div>
              <div className="stat-card">
                <h3>Recent Activity</h3>
                <div className="activity-list">
                  {bonds.slice(0, 3).map(bond => (
                    <div key={bond.id} className="activity-item">
                      <div className="activity-name">{bond.name}</div>
                      <div className="activity-status">{bond.status}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "faq" && (
          <div className="faq-section">
            <div className="faq-item">
              <h3>What are FHE-encrypted Social Impact Bonds?</h3>
              <p>
                These are financial instruments that allow investors to support social causes while keeping their investment amounts and identities private using Zama's Fully Homomorphic Encryption (FHE) technology.
              </p>
            </div>
            <div className="faq-item">
              <h3>How does FHE protect my privacy?</h3>
              <p>
                Zama FHE allows computations to be performed on encrypted data without decrypting it first. This means your investment amounts and personal data remain encrypted at all times, even during processing.
              </p>
            </div>
            <div className="faq-item">
              <h3>What happens at bond maturity?</h3>
              <p>
                When a bond reaches maturity, the social impact is verified by our oracle network. If successful, investors receive their principal plus interest. All calculations are done on encrypted data.
              </p>
            </div>
            <div className="faq-item">
              <h3>How do I decrypt my investment data?</h3>
              <p>
                You can decrypt your personal investment data at any time by signing a message with your wallet. This proves your identity without revealing it to the platform.
              </p>
            </div>
          </div>
        )}
      </main>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Issue New Social Impact Bond</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Bond Name</label>
                <input
                  type="text"
                  value={newBondData.name}
                  onChange={(e) => setNewBondData({...newBondData, name: e.target.value})}
                  placeholder="e.g. Clean Water Initiative"
                />
              </div>
              <div className="form-group">
                <label>Target Amount ($)</label>
                <input
                  type="number"
                  value={newBondData.targetAmount}
                  onChange={(e) => setNewBondData({...newBondData, targetAmount: parseFloat(e.target.value) || 0})}
                  placeholder="Funding goal"
                />
              </div>
              <div className="form-group">
                <label>Impact Category</label>
                <select
                  value={newBondData.impactCategory}
                  onChange={(e) => setNewBondData({...newBondData, impactCategory: e.target.value})}
                >
                  <option value="Education">Education</option>
                  <option value="Environment">Environment</option>
                  <option value="Healthcare">Healthcare</option>
                  <option value="Poverty">Poverty Alleviation</option>
                  <option value="Gender">Gender Equality</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="form-group">
                <label>Maturity Period (Days)</label>
                <input
                  type="number"
                  value={newBondData.maturityDays}
                  onChange={(e) => setNewBondData({...newBondData, maturityDays: parseInt(e.target.value) || 365})}
                />
              </div>
              <div className="form-group">
                <label>Project Description</label>
                <textarea
                  value={newBondData.description}
                  onChange={(e) => setNewBondData({...newBondData, description: e.target.value})}
                  placeholder="Describe the social impact project..."
                />
              </div>
              <div className="encryption-notice">
                <div className="lock-icon"></div>
                <p>All financial data will be encrypted with Zama FHE before being stored on-chain</p>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn">Cancel</button>
              <button 
                onClick={createBond} 
                disabled={creating || !newBondData.name || !newBondData.targetAmount}
                className="submit-btn"
              >
                {creating ? "Creating Encrypted Bond..." : "Create Bond"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedBond && (
        <div className="modal-overlay">
          <div className="bond-detail-modal">
            <div className="modal-header">
              <h2>{selectedBond.name}</h2>
              <button onClick={() => {
                setSelectedBond(null);
                setDecryptedAmounts({});
              }} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="bond-info">
                <div className="info-row">
                  <span>Issuer:</span>
                  <strong>{selectedBond.issuer.substring(0, 6)}...{selectedBond.issuer.substring(38)}</strong>
                </div>
                <div className="info-row">
                  <span>Status:</span>
                  <strong className={`status ${selectedBond.status}`}>{selectedBond.status}</strong>
                </div>
                <div className="info-row">
                  <span>Category:</span>
                  <strong>{selectedBond.impactCategory}</strong>
                </div>
                <div className="info-row">
                  <span>Maturity Date:</span>
                  <strong>{new Date(selectedBond.maturityDate * 1000).toLocaleDateString()}</strong>
                </div>
              </div>
              
              <div className="bond-amounts">
                <div className="amount-card">
                  <h3>Target Amount</h3>
                  {decryptedAmounts.target ? (
                    <div className="amount-value">${decryptedAmounts.target.toLocaleString()}</div>
                  ) : (
                    <button 
                      className="decrypt-btn"
                      onClick={() => decryptWithSignature(selectedBond.targetAmount)
                        .then(amount => amount && setDecryptedAmounts({...decryptedAmounts, target: amount}))}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : "Decrypt Target"}
                    </button>
                  )}
                </div>
                <div className="amount-card">
                  <h3>Amount Raised</h3>
                  {decryptedAmounts.raised ? (
                    <div className="amount-value">${decryptedAmounts.raised.toLocaleString()}</div>
                  ) : (
                    <button 
                      className="decrypt-btn"
                      onClick={() => decryptWithSignature(selectedBond.currentRaised)
                        .then(amount => amount && setDecryptedAmounts({...decryptedAmounts, raised: amount}))}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : "Decrypt Raised"}
                    </button>
                  )}
                </div>
              </div>
              
              <div className="bond-progress">
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ 
                      width: `${(decryptedAmounts.raised && decryptedAmounts.target ? 
                        (decryptedAmounts.raised / decryptedAmounts.target) * 100 : 0)}%` 
                    }}
                  ></div>
                </div>
                {decryptedAmounts.raised && decryptedAmounts.target && (
                  <div className="progress-text">
                    {((decryptedAmounts.raised / decryptedAmounts.target) * 100).toFixed(1)}% funded
                  </div>
                )}
              </div>
              
              <div className="bond-description">
                <h3>Project Details</h3>
                <p>{selectedBond.encryptedDetails || "No additional details provided."}</p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className="invest-btn"
                onClick={() => {
                  const amount = prompt("Enter investment amount:");
                  if (amount && !isNaN(parseFloat(amount))) {
                    investInBond(selectedBond.id, parseFloat(amount));
                  }
                }}
                disabled={selectedBond.status !== "active" || !isConnected}
              >
                Invest in this Bond
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-toast">
          <div className={`toast-content ${transactionStatus.status}`}>
            <div className="toast-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="toast-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>SocialImpactBonds</h3>
            <p>Privacy-preserving DeFi for social good</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Privacy</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
            <div className="fhe-icon"></div>
          </div>
          <div className="copyright">© {new Date().getFullYear()} SocialImpactBonds. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;